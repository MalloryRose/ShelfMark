/**
 * Shelf entries in, work identities out.
 *
 * This is the seam phase 2 replaces. Today a work identity is derived locally
 * from the normalised title and author surname, which is enough to drive
 * OverDrive lookups. When the Open Library resolver lands, `toWork` becomes an
 * async call that returns a real `OL…W` key and the full edition ISBN cluster —
 * and nothing else in the codebase has to change, because everything downstream
 * already speaks `WorkIdentity`.
 */

import { putShelfEntries, pruneShelfEntries, putWorks, allShelfEntries } from '../core/db';
import type { ShelfEntry, WorkIdentity } from '../core/types';
import { authorSurname, localWorkId, normalizeAuthor, normalizeTitle } from '../lib/normalize';
import { fetchShelves } from './goodreads-rss';

/** One shelf entry → the work it refers to. Pure; phase 2 makes it async. */
export function toWork(entry: ShelfEntry): WorkIdentity {
  return {
    workId: localWorkId(entry.title, entry.author),
    title: entry.title,
    author: entry.author,
    normalizedTitle: normalizeTitle(entry.title),
    normalizedAuthor: normalizeAuthor(entry.author),
    // A single ISBN today; phase 2 expands this to the edition cluster, which
    // is what makes print catalog lookups actually hit.
    isbns: entry.isbn ? [entry.isbn] : [],
    coverUrl: entry.coverUrl,
  };
}

/**
 * Collapse entries onto works. Two shelf rows for the same book — a hardback
 * and an audiobook edition, say — are one work with one lookup, which is also
 * the fix for the duplicate cards in the reference UI.
 */
export function toWorks(entries: ShelfEntry[]): WorkIdentity[] {
  const byId = new Map<string, WorkIdentity>();

  for (const entry of entries) {
    const work = toWork(entry);
    const existing = byId.get(work.workId);
    if (!existing) {
      byId.set(work.workId, work);
      continue;
    }
    // Merge what the duplicate knows that the first copy didn't.
    existing.isbns = [...new Set([...existing.isbns, ...work.isbns])];
    existing.coverUrl ??= work.coverUrl;
  }

  return [...byId.values()];
}

export interface SyncResult {
  entries: number;
  works: number;
  removed: number;
}

/**
 * Pull the selected shelves and reconcile local state with them.
 *
 * Entries no longer on any selected shelf are pruned — unshelving a book should
 * remove it from results rather than leaving a ghost that never updates.
 */
export async function syncShelves(
  goodreadsId: string,
  shelves: string[],
  signal?: AbortSignal,
): Promise<SyncResult> {
  const entries = await fetchShelves(goodreadsId, shelves, { signal });

  if (entries.length === 0) {
    throw new Error(
      'No books found. Check that the profile is public and the shelf is not empty.',
    );
  }

  await putShelfEntries(entries);
  const removed = await pruneShelfEntries(new Set(entries.map((e) => e.id)));

  const works = toWorks(entries);
  await putWorks(works);

  return { entries: entries.length, works: works.length, removed };
}

/** Rebuild works from whatever is already stored — used after a CSV import. */
export async function rebuildWorks(): Promise<number> {
  const works = toWorks(await allShelfEntries());
  await putWorks(works);
  return works.length;
}

/** Re-exported so callers don't reach past this module into normalize. */
export { authorSurname };
