/**
 * IndexedDB, not chrome.storage.local.
 *
 * Two reasons. The 10MB storage.local quota is reachable at a few hundred works
 * across several libraries — but more importantly storage.local cannot query,
 * which is why the reference implementation re-reads and re-renders its entire
 * book array every time a filter changes. Settings stay in storage.local;
 * anything we need to filter or count lives here.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Holding,
  ScanRun,
  ScanTask,
  ShelfEntry,
  WorkIdentity,
} from './types';
import { holdingKey } from './types';

const DB_NAME = 'shelfmark';
const DB_VERSION = 1;

interface ShelfmarkDB extends DBSchema {
  shelfEntries: {
    key: string;
    value: ShelfEntry;
    indexes: { 'by-source': string };
  };
  works: {
    key: string;
    value: WorkIdentity;
    indexes: { 'by-normalized-title': string };
  };
  holdings: {
    key: string;
    value: Holding;
    indexes: {
      'by-work': string;
      'by-library': string;
      'by-status': string;
      'by-fetched': number;
    };
  };
  scanTasks: {
    key: string;
    value: ScanTask;
    indexes: { 'by-run-state': [string, string]; 'by-run': string };
  };
  scanRuns: {
    key: string;
    value: ScanRun;
  };
}

let dbPromise: Promise<IDBPDatabase<ShelfmarkDB>> | undefined;

export function db(): Promise<IDBPDatabase<ShelfmarkDB>> {
  dbPromise ??= openDB<ShelfmarkDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const shelf = database.createObjectStore('shelfEntries', { keyPath: 'id' });
      shelf.createIndex('by-source', 'sourceId');

      const works = database.createObjectStore('works', { keyPath: 'workId' });
      works.createIndex('by-normalized-title', 'normalizedTitle');

      const holdings = database.createObjectStore('holdings');
      holdings.createIndex('by-work', 'workId');
      holdings.createIndex('by-library', 'libraryId');
      holdings.createIndex('by-status', 'status');
      holdings.createIndex('by-fetched', 'fetchedAt');

      const tasks = database.createObjectStore('scanTasks', { keyPath: 'id' });
      // Composite index — "the pending tasks for this run" is the queue's only
      // hot read, and it runs on every tick.
      tasks.createIndex('by-run-state', ['runId', 'state']);
      tasks.createIndex('by-run', 'runId');

      database.createObjectStore('scanRuns', { keyPath: 'id' });
    },
  });
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Shelf entries
// ---------------------------------------------------------------------------

export async function putShelfEntries(entries: ShelfEntry[]): Promise<void> {
  const database = await db();
  const tx = database.transaction('shelfEntries', 'readwrite');
  await Promise.all(entries.map((e) => tx.store.put(e)));
  await tx.done;
}

export async function allShelfEntries(): Promise<ShelfEntry[]> {
  return (await db()).getAll('shelfEntries');
}

/**
 * Remove entries no longer on any watched shelf. Returns how many went.
 * Unshelving a book should remove it from results, not leave a ghost.
 */
export async function pruneShelfEntries(keepIds: Set<string>): Promise<number> {
  const database = await db();
  const tx = database.transaction('shelfEntries', 'readwrite');
  let removed = 0;
  for (const key of await tx.store.getAllKeys()) {
    if (!keepIds.has(key)) {
      await tx.store.delete(key);
      removed++;
    }
  }
  await tx.done;
  return removed;
}

// ---------------------------------------------------------------------------
// Works
// ---------------------------------------------------------------------------

export async function putWorks(works: WorkIdentity[]): Promise<void> {
  const database = await db();
  const tx = database.transaction('works', 'readwrite');
  await Promise.all(works.map((w) => tx.store.put(w)));
  await tx.done;
}

export async function getWork(workId: string): Promise<WorkIdentity | undefined> {
  return (await db()).get('works', workId);
}

export async function allWorks(): Promise<WorkIdentity[]> {
  return (await db()).getAll('works');
}

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

/** Digital availability turns over in hours; print stock moves far slower. */
export const HOLDING_TTL_MS = {
  digital: 6 * 60 * 60 * 1000,
  print: 24 * 60 * 60 * 1000,
} as const;

export function isStale(holding: Holding, now = Date.now()): boolean {
  const ttl = holding.format === 'print' || holding.format === 'large-print'
    ? HOLDING_TTL_MS.print
    : HOLDING_TTL_MS.digital;
  return now - holding.fetchedAt > ttl;
}

export async function putHoldings(holdings: Holding[]): Promise<void> {
  const database = await db();
  const tx = database.transaction('holdings', 'readwrite');
  await Promise.all(holdings.map((h) => tx.store.put(h, holdingKey(h))));
  await tx.done;
}

export async function holdingsForWork(workId: string): Promise<Holding[]> {
  return (await db()).getAllFromIndex('holdings', 'by-work', workId);
}

export async function allHoldings(): Promise<Holding[]> {
  return (await db()).getAll('holdings');
}

export async function availableHoldings(): Promise<Holding[]> {
  return (await db()).getAllFromIndex('holdings', 'by-status', 'available');
}

/**
 * Drop every holding for a library the user removed. Without this, deleting a
 * library leaves its results in the UI forever.
 */
export async function deleteHoldingsForLibrary(libraryId: string): Promise<void> {
  const database = await db();
  const tx = database.transaction('holdings', 'readwrite');
  const index = tx.store.index('by-library');
  for await (const cursor of index.iterate(libraryId)) {
    await cursor.delete();
  }
  await tx.done;
}

// ---------------------------------------------------------------------------
// Scan runs & tasks
// ---------------------------------------------------------------------------

export async function putRun(run: ScanRun): Promise<void> {
  await (await db()).put('scanRuns', run);
}

export async function getRun(runId: string): Promise<ScanRun | undefined> {
  return (await db()).get('scanRuns', runId);
}

export async function latestRun(): Promise<ScanRun | undefined> {
  const runs = await (await db()).getAll('scanRuns');
  return runs.sort((a, b) => b.startedAt - a.startedAt)[0];
}

export async function putTasks(tasks: ScanTask[]): Promise<void> {
  const database = await db();
  const tx = database.transaction('scanTasks', 'readwrite');
  await Promise.all(tasks.map((t) => tx.store.put(t)));
  await tx.done;
}

export async function putTask(task: ScanTask): Promise<void> {
  await (await db()).put('scanTasks', task);
}

/**
 * Next batch of runnable work. Backed-off tasks whose time hasn't come are
 * filtered out here rather than being retried and failing again.
 */
export async function claimPendingTasks(
  runId: string,
  limit: number,
  now = Date.now(),
): Promise<ScanTask[]> {
  const database = await db();
  const pending = await database.getAllFromIndex('scanTasks', 'by-run-state', [
    runId,
    'pending',
  ]);
  return pending.filter((t) => t.nextAttemptAt <= now).slice(0, limit);
}

export async function countPendingTasks(runId: string): Promise<number> {
  return (await db()).countFromIndex('scanTasks', 'by-run-state', [runId, 'pending']);
}

/** Tasks are per-run bookkeeping; once a run ends they are noise. */
export async function deleteTasksForRun(runId: string): Promise<void> {
  const database = await db();
  const tx = database.transaction('scanTasks', 'readwrite');
  const index = tx.store.index('by-run');
  for await (const cursor of index.iterate(runId)) {
    await cursor.delete();
  }
  await tx.done;
}
