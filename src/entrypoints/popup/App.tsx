/**
 * Phase 1 popup — a working harness, not the finished interface.
 *
 * The plan puts the real UI in phase 4: this popup becomes pure triage ("9 of
 * 312 available now") and browsing moves to a full extension page. What is here
 * now is enough to drive and observe the pipeline end to end, which is what a
 * scaffold owes you.
 */

import { useEffect, useState } from 'preact/hooks';
import { browser } from '#imports';
import { availableHoldings, allWorks } from '../../core/db';
import { MessageError, onEvent, send, type ScanProgress } from '../../core/messages';
import { getSettings, patchSettings, requestLibraryPermission } from '../../core/settings';
import type { Holding, ScanRun, WorkIdentity } from '../../core/types';
import { parseGoodreadsId } from '../../shelf/goodreads-rss';
import { parseOverdriveKey } from '../../providers/overdrive';

interface Row {
  work: WorkIdentity;
  holdings: Holding[];
}

export function App() {
  const [goodreads, setGoodreads] = useState('');
  const [library, setLibrary] = useState('');
  const [shelfCount, setShelfCount] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [run, setRun] = useState<ScanRun | undefined>();
  const [progress, setProgress] = useState<ScanProgress | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void (async () => {
      const settings = await getSettings();
      if (settings.goodreadsId) setGoodreads(settings.goodreadsId);
      if (settings.libraries[0]?.providerKey) setLibrary(settings.libraries[0].providerKey);

      // Offer the auto-detected profile when the user hasn't set one.
      if (!settings.goodreadsId) {
        const { detectedGoodreadsId } = await browser.storage.local.get('detectedGoodreadsId');
        if (typeof detectedGoodreadsId === 'string') setGoodreads(detectedGoodreadsId);
      }

      setShelfCount((await allWorks()).length);
      setRun((await send('scan:status', {})).run);
      await refreshResults();
    })();

    const offProgress = onEvent('scan:progress', setProgress);
    const offComplete = onEvent('scan:complete', () => {
      setProgress(undefined);
      void refreshResults();
      void send('scan:status', {}).then((r) => setRun(r.run));
    });
    return () => {
      offProgress();
      offComplete();
    };
  }, []);

  async function refreshResults() {
    const [works, available] = await Promise.all([allWorks(), availableHoldings()]);
    const byWork = new Map<string, Holding[]>();
    for (const holding of available) {
      byWork.set(holding.workId, [...(byWork.get(holding.workId) ?? []), holding]);
    }
    setRows(
      works
        .filter((w) => byWork.has(w.workId))
        .map((work) => ({ work, holdings: byWork.get(work.workId)! })),
    );
  }

  async function guard(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof MessageError || err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  const onSync = () =>
    guard('Reading your shelf…', async () => {
      const id = parseGoodreadsId(goodreads);
      if (!id) throw new Error('Enter a Goodreads profile URL or user id.');
      const { entries } = await send('shelf:sync', { goodreadsId: id, shelves: ['to-read'] });
      setShelfCount(entries);
    });

  const onSaveLibrary = () =>
    guard('Adding library…', async () => {
      const key = parseOverdriveKey(library);
      if (!key) throw new Error('Enter your OverDrive address, e.g. lapl.overdrive.com');

      const baseUrl = `https://${key}.overdrive.com`;
      // Ask for this origin only now — a fresh install can reach no catalog.
      if (!(await requestLibraryPermission(baseUrl))) {
        throw new Error('Permission is needed to read this library’s catalog.');
      }

      await patchSettings({
        libraries: [
          {
            id: `overdrive:${key}`,
            label: key.toUpperCase(),
            providerId: 'overdrive',
            baseUrl,
            providerKey: key,
            enabled: true,
          },
        ],
      });
    });

  const onScan = () =>
    guard('Starting scan…', async () => {
      await send('scan:start', { source: 'manual' });
      setRun((await send('scan:status', {})).run);
    });

  const onCancel = () =>
    guard('Cancelling…', async () => {
      await send('scan:cancel', {});
      setProgress(undefined);
      setRun((await send('scan:status', {})).run);
    });

  const scanning = run?.status === 'running';

  return (
    <div class="flex flex-col gap-4 p-4">
      <header class="flex items-baseline justify-between border-b border-[--color-rule] pb-3">
        <h1 class="m-0 font-[--font-display] text-lg font-semibold">Shelfmark</h1>
        <span class="font-[--font-mono] text-[11px] text-[--color-ink-3]">
          {shelfCount} {shelfCount === 1 ? 'book' : 'books'}
        </span>
      </header>

      <label class="flex flex-col gap-1">
        <span class="font-[--font-mono] text-[10px] uppercase tracking-wider text-[--color-ink-3]">
          Goodreads profile
        </span>
        <div class="flex gap-2">
          <input
            class="min-w-0 flex-1 rounded border border-[--color-rule] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink]"
            placeholder="goodreads.com/user/show/12345678"
            value={goodreads}
            onInput={(e) => setGoodreads((e.target as HTMLInputElement).value)}
          />
          <button
            class="rounded bg-[--color-stamp] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!!busy}
            onClick={onSync}
          >
            Sync
          </button>
        </div>
      </label>

      <label class="flex flex-col gap-1">
        <span class="font-[--font-mono] text-[10px] uppercase tracking-wider text-[--color-ink-3]">
          OverDrive library
        </span>
        <div class="flex gap-2">
          <input
            class="min-w-0 flex-1 rounded border border-[--color-rule] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink]"
            placeholder="lapl.overdrive.com"
            value={library}
            onInput={(e) => setLibrary((e.target as HTMLInputElement).value)}
          />
          <button
            class="rounded border border-[--color-rule] px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={!!busy}
            onClick={onSaveLibrary}
          >
            Add
          </button>
        </div>
      </label>

      <div class="flex items-center gap-2">
        <button
          class="flex-1 rounded bg-[--color-stamp] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          disabled={!!busy || scanning || shelfCount === 0}
          onClick={onScan}
        >
          {scanning ? 'Scanning…' : 'Scan my libraries'}
        </button>
        {scanning && (
          <button class="rounded border border-[--color-rule] px-3 py-2 text-sm" onClick={onCancel}>
            Stop
          </button>
        )}
      </div>

      {busy && <p class="m-0 text-sm text-[--color-ink-2]">{busy}</p>}

      {progress && (
        <div class="flex flex-col gap-1">
          <div class="h-1.5 overflow-hidden rounded bg-[--color-sunk]">
            <div
              class="h-full bg-[--color-stamp]"
              style={{
                width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
              }}
            />
          </div>
          <span class="font-[--font-mono] text-[11px] text-[--color-ink-3]">
            {progress.done} of {progress.total}
            {progress.failed > 0 && ` · ${progress.failed} failed`}
          </span>
        </div>
      )}

      {error && (
        <p class="m-0 rounded border border-[--color-queue] px-2 py-1.5 text-sm text-[--color-queue]">
          {error}
        </p>
      )}

      <section class="flex flex-col gap-2">
        <h2 class="m-0 font-[--font-mono] text-[10px] uppercase tracking-wider text-[--color-ink-3]">
          Available now
        </h2>

        {rows.length === 0 ? (
          <p class="m-0 text-sm text-[--color-ink-2]">
            {shelfCount === 0
              ? 'Sync a shelf and add a library to get started.'
              : 'Nothing available yet — run a scan.'}
          </p>
        ) : (
          rows.map(({ work, holdings }) => (
            <article
              key={work.workId}
              class="flex flex-col gap-1 rounded border border-[--color-rule] bg-[--color-surface] p-2"
            >
              <p class="m-0 font-[--font-display] text-sm font-semibold">{work.title}</p>
              <p class="m-0 text-xs text-[--color-ink-2]">{work.author}</p>
              <div class="flex flex-wrap gap-1">
                {holdings.map((h) => (
                  <a
                    key={`${h.libraryId}-${h.format}`}
                    href={h.itemUrl}
                    target="_blank"
                    rel="noopener"
                    class="rounded bg-[--color-sunk] px-1.5 py-0.5 font-[--font-mono] text-[10px] uppercase tracking-wide text-[--color-shelf] no-underline"
                  >
                    {h.format} · {h.copiesAvailable ?? 0} free
                  </a>
                ))}
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
