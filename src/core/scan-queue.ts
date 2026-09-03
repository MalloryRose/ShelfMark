/**
 * The scan, built as a resumable queue rather than a loop.
 *
 * Chrome terminates an extension service worker when a single event takes more
 * than five minutes to process. A scan driven from one `onMessage` handler *is*
 * one event, so a large first scan gets killed mid-flight — no completion, no
 * error, and any state held in module scope gone. That is exactly how the
 * reference implementation strands its `currently_scanning` flag and silently
 * kills auto-scan for the rest of the browser session.
 *
 * So: every unit of work is persisted before any network call, each tick does a
 * bounded amount of work and hands control back, and the next tick is scheduled
 * through `chrome.alarms`. Termination becomes a pause. The only state that
 * matters lives in IndexedDB, and a cold worker resumes from it.
 */

import { browser } from '#imports';
import {
  claimPendingTasks,
  countPendingTasks,
  deleteTasksForRun,
  getRun,
  latestRun,
  putHoldings,
  putRun,
  putTask,
  putTasks,
  allWorks,
} from './db';
import { emit } from './messages';
import { enabledLibraries } from './settings';
import type { ScanRun, ScanTask } from './types';
import { getProvider } from '../providers';
import { backoffMs, HttpError, TimeoutError } from '../lib/http';

/**
 * Wall-clock budget for one tick. Chrome's hard limit is 5 minutes per event;
 * stopping at 3m20s leaves generous room for the final writes to land.
 */
const TICK_BUDGET_MS = 200_000;

/** Tasks dispatched concurrently within a tick. Politeness over throughput. */
const BATCH_SIZE = 6;

/** Chrome clamps alarm delays to a 30-second floor, so this is the real minimum. */
const RESUME_DELAY_MIN = 0.5;

const MAX_ATTEMPTS = 3;

/** Consecutive failures before a provider is considered down for this run. */
const BREAKER_THRESHOLD = 5;

export const SCAN_ALARM = 'shelfmark:scan-tick';

// ---------------------------------------------------------------------------
// Starting and stopping
// ---------------------------------------------------------------------------

/**
 * Build a run from the current shelf and libraries, persist every task, then
 * hand off to the tick. Deliberately does no network work itself — if this
 * function is interrupted, nothing has been half-done.
 */
export async function startScan(source: 'manual' | 'auto'): Promise<string> {
  const active = await activeRun();
  if (active) {
    // Supersede rather than run two scans over the same rows.
    await finishRun(active, 'cancelled');
  }

  const [works, libraries] = await Promise.all([allWorks(), enabledLibraries()]);

  if (works.length === 0) throw new Error('No books on the selected shelves yet — sync a shelf first.');
  if (libraries.length === 0) throw new Error('Add a library before scanning.');

  const runId = `run:${Date.now()}`;
  const tasks: ScanTask[] = [];

  for (const library of libraries) {
    const provider = getProvider(library.providerId);
    if (!provider) continue; // library configured for a provider we no longer ship
    for (const work of works) {
      tasks.push({
        id: `${runId}::${work.workId}::${library.id}`,
        runId,
        workId: work.workId,
        libraryId: library.id,
        providerId: library.providerId,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
      });
    }
  }

  const run: ScanRun = {
    id: runId,
    source,
    status: 'running',
    startedAt: Date.now(),
    total: tasks.length,
    done: 0,
    failed: 0,
    degradedProviders: [],
  };

  // Order matters: tasks first, so a crash between the two writes leaves
  // orphaned tasks (harmless) rather than a run with no work (stuck at 0%).
  await putTasks(tasks);
  await putRun(run);

  await scheduleTick(0);
  return runId;
}

export async function cancelScan(): Promise<boolean> {
  const run = await activeRun();
  if (!run) return false;
  await finishRun(run, 'cancelled');
  await browser.alarms.clear(SCAN_ALARM);
  return true;
}

export async function activeRun(): Promise<ScanRun | undefined> {
  const run = await latestRun();
  return run?.status === 'running' ? run : undefined;
}

async function scheduleTick(delayMinutes: number): Promise<void> {
  if (delayMinutes <= 0) {
    // Same-turn continuation. Not awaited into the caller's critical path.
    void runScanTick();
    return;
  }
  await browser.alarms.create(SCAN_ALARM, { delayInMinutes: delayMinutes });
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Drain work until the budget runs out, then reschedule.
 *
 * Safe to call spuriously — on a cold worker, on an alarm that fired after a
 * run already finished, or twice in quick succession. It reads its state from
 * the database every time and holds nothing between calls.
 */
export async function runScanTick(): Promise<void> {
  const run = await activeRun();
  if (!run) return;

  const deadline = Date.now() + TICK_BUDGET_MS;
  const breaker = new Map<string, number>();

  while (Date.now() < deadline) {
    const batch = await claimPendingTasks(run.id, BATCH_SIZE);
    if (batch.length === 0) break;

    // Failing fast on a provider that is clearly down beats spending the whole
    // budget collecting the same timeout N times.
    const runnable = batch.filter((t) => (breaker.get(t.providerId) ?? 0) < BREAKER_THRESHOLD);
    if (runnable.length === 0) break;

    const results = await Promise.allSettled(runnable.map((task) => runTask(task, run)));

    for (const [i, result] of results.entries()) {
      const task = runnable[i]!;
      if (result.status === 'fulfilled' && result.value) {
        breaker.set(task.providerId, 0);
      } else {
        breaker.set(task.providerId, (breaker.get(task.providerId) ?? 0) + 1);
      }
    }

    await refreshCounts(run);
    await emit('scan:progress', {
      runId: run.id,
      total: run.total,
      done: run.done,
      failed: run.failed,
      label: describe(run),
    });
  }

  for (const [providerId, failures] of breaker) {
    if (failures >= BREAKER_THRESHOLD && !run.degradedProviders.includes(providerId)) {
      run.degradedProviders.push(providerId);
    }
  }

  const remaining = await countPendingTasks(run.id);
  if (remaining === 0) {
    await finishRun(run, 'complete');
    return;
  }

  // Budget spent with work left. Checkpoint and let the alarm bring us back —
  // if the worker dies in the gap, the alarm still fires and we resume here.
  await putRun(run);
  await scheduleTick(RESUME_DELAY_MIN);
}

/**
 * One (work × library) lookup. Returns true on success.
 *
 * The task row is written after every outcome, so the most a hard termination
 * can cost is a single in-flight request.
 */
async function runTask(task: ScanTask, run: ScanRun): Promise<boolean> {
  const provider = getProvider(task.providerId);
  const libraries = await enabledLibraries();
  const library = libraries.find((l) => l.id === task.libraryId);
  const work = (await allWorks()).find((w) => w.workId === task.workId);

  if (!provider || !library || !work) {
    await putTask({ ...task, state: 'failed', error: 'configuration changed mid-scan' });
    return false;
  }

  try {
    const holdings = await provider.lookup({
      work,
      library,
      signal: AbortSignal.timeout(25_000),
    });
    if (holdings.length > 0) await putHoldings(holdings);
    await putTask({ ...task, state: 'done', attempts: task.attempts + 1 });
    return true;
  } catch (error) {
    const attempts = task.attempts + 1;
    const retryable = isRetryable(error) && attempts < MAX_ATTEMPTS;

    await putTask({
      ...task,
      attempts,
      state: retryable ? 'pending' : 'failed',
      nextAttemptAt: retryable ? Date.now() + backoffMs(attempts) : 0,
      error: error instanceof Error ? error.message : String(error),
    });

    void run; // run counters are recomputed in refreshCounts
    return false;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (error instanceof HttpError) return error.retryable;
  // A bare network failure (catalog briefly unreachable) is worth one more go.
  return error instanceof TypeError;
}

async function refreshCounts(run: ScanRun): Promise<void> {
  const pending = await countPendingTasks(run.id);
  run.done = run.total - pending - run.failed;
  await putRun(run);
}

async function finishRun(run: ScanRun, status: ScanRun['status']): Promise<void> {
  const finished: ScanRun = { ...run, status, finishedAt: Date.now() };
  await putRun(finished);
  await deleteTasksForRun(run.id);
  await browser.alarms.clear(SCAN_ALARM);

  if (status === 'complete') {
    const { availableHoldings } = await import('./db');
    const available = (await availableHoldings()).length;
    await emit('scan:complete', { runId: run.id, available });
  } else if (status === 'failed') {
    await emit('scan:failed', { runId: run.id, reason: 'scan failed' });
  }
}

function describe(run: ScanRun): string {
  const pct = run.total === 0 ? 0 : Math.floor((run.done / run.total) * 100);
  return `Checking your libraries — ${pct}%`;
}

/**
 * Called on worker startup. If a run was interrupted by termination, no alarm
 * may be outstanding, and without this the scan would sit at whatever
 * percentage it reached until the user noticed.
 */
export async function resumeInterruptedScan(): Promise<void> {
  const run = await activeRun();
  if (!run) return;

  const existing = await browser.alarms.get(SCAN_ALARM);
  if (!existing) await scheduleTick(RESUME_DELAY_MIN);
}

/** Progress for the popup, derived rather than remembered. */
export async function scanStatus(): Promise<ScanRun | undefined> {
  const run = await activeRun();
  return run ?? (await latestRun());
}

export async function runById(runId: string): Promise<ScanRun | undefined> {
  return getRun(runId);
}
