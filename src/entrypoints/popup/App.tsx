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
import type { Holding, LibraryConfig, ScanRun, WorkIdentity } from '../../core/types';
import { parseGoodreadsId } from '../../shelf/goodreads-rss';
import { parseBiblioCommonsKey } from '../../providers/bibliocommons';
import { parseOverdriveKey } from '../../providers/overdrive';
import { parsePolarisBaseUrl, polarisProvider } from '../../providers/polaris';

type LibraryKind = 'overdrive' | 'bibliocommons' | 'polaris';

const KIND_LABEL: Record<LibraryKind, { name: string; placeholder: string }> = {
  overdrive: { name: 'OverDrive / Libby (ebooks & audiobooks)', placeholder: 'lapl.overdrive.com' },
  bibliocommons: { name: 'BiblioCommons catalog (print)', placeholder: 'seattle.bibliocommons.com' },
  polaris: { name: 'Polaris catalog (print)', placeholder: 'catalog.denverlibrary.org' },
};

/** What the user typed → a library entry, or a message saying what to type instead. */
async function toLibraryConfig(kind: LibraryKind, input: string): Promise<LibraryConfig> {
  switch (kind) {
    case 'overdrive': {
      const key = parseOverdriveKey(input);
      if (!key) throw new Error('Enter your OverDrive address, e.g. lapl.overdrive.com');
      const baseUrl = `https://${key}.overdrive.com`;
      // Ask for this origin only now — a fresh install can reach no catalog.
      if (!(await requestLibraryPermission(baseUrl))) {
        throw new Error('Permission is needed to read this library’s catalog.');
      }
      return {
        id: `overdrive:${key}`,
        label: key.toUpperCase(),
        providerId: 'overdrive',
        baseUrl,
        providerKey: key,
        enabled: true,
      };
    }
    case 'bibliocommons': {
      const key = parseBiblioCommonsKey(input);
      if (!key) throw new Error('Enter your catalog address, e.g. seattle.bibliocommons.com');
      // Lookups go to the shared gateway, already in host_permissions; the
      // catalog host is only ever opened as a link, which needs no grant.
      return {
        id: `bibliocommons:${key}`,
        label: key.toUpperCase(),
        providerId: 'bibliocommons',
        baseUrl: `https://${key}.bibliocommons.com`,
        providerKey: key,
        enabled: true,
      };
    }
    case 'polaris': {
      const baseUrl = parsePolarisBaseUrl(input);
      if (!baseUrl) throw new Error('Enter your catalog address, e.g. catalog.denverlibrary.org');
      if (!(await requestLibraryPermission(baseUrl))) {
        throw new Error('Permission is needed to read this library’s catalog.');
      }
      // Catch a wrong URL now, not as a scan where every book fails.
      if ((await polarisProvider.detect?.(baseUrl, AbortSignal.timeout(15_000))) === false) {
        throw new Error('That address doesn’t look like a Polaris catalog.');
      }
      const host = new URL(baseUrl).host;
      return { id: `polaris:${host}`, label: host, providerId: 'polaris', baseUrl, enabled: true };
    }
  }
}

interface Row {
  work: WorkIdentity;
  holdings: Holding[];
}

export function App() {
  const [goodreads, setGoodreads] = useState('');
  const [library, setLibrary] = useState('');
  const [libraryKind, setLibraryKind] = useState<LibraryKind>('bibliocommons');
  const [libraries, setLibraries] = useState<LibraryConfig[]>([]);
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
      setLibraries(settings.libraries);

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
      const entry = await toLibraryConfig(libraryKind, library);
      // Replace by id, keep the rest: a reader with print and Libby needs both.
      const { libraries: current } = await getSettings();
      const next = await patchSettings({
        libraries: [...current.filter((l) => l.id !== entry.id), entry],
      });
      setLibraries(next.libraries);
      setLibrary('');
    });

  const onRemoveLibrary = (id: string) =>
    guard('Removing library…', async () => {
      const { libraries: current } = await getSettings();
      const next = await patchSettings({ libraries: current.filter((l) => l.id !== id) });
      setLibraries(next.libraries);
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

      <div class="flex flex-col gap-1">
        <span class="font-[--font-mono] text-[10px] uppercase tracking-wider text-[--color-ink-3]">
          Libraries
        </span>
        {libraries.length > 0 && (
          <ul class="m-0 flex list-none flex-col gap-1 p-0">
            {libraries.map((l) => (
              <li key={l.id} class="flex items-center justify-between gap-2 text-sm">
                <span>
                  {l.label}{' '}
                  <span class="font-[--font-mono] text-[10px] text-[--color-ink-3]">{l.providerId}</span>
                </span>
                <button
                  class="rounded border border-[--color-rule] px-2 py-0.5 text-xs disabled:opacity-50"
                  disabled={!!busy || scanning}
                  aria-label={`Remove ${l.label}`}
                  onClick={() => onRemoveLibrary(l.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <select
          class="rounded border border-[--color-rule] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink]"
          aria-label="Library catalog type"
          value={libraryKind}
          onChange={(e) => setLibraryKind((e.target as HTMLSelectElement).value as LibraryKind)}
        >
          {(Object.keys(KIND_LABEL) as LibraryKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind].name}
            </option>
          ))}
        </select>
        <div class="flex gap-2">
          <input
            class="min-w-0 flex-1 rounded border border-[--color-rule] bg-[--color-surface] px-2 py-1.5 text-sm text-[--color-ink]"
            aria-label="Library address"
            placeholder={KIND_LABEL[libraryKind].placeholder}
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
      </div>

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
                    {h.format} ·{' '}
                    {h.branches?.find((b) => b.status === 'available')?.name ??
                      `${h.copiesAvailable ?? 0} free`}
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
