/**
 * Goodreads shelves via the public RSS feed.
 *
 *   https://www.goodreads.com/review/list_rss/{userId}?shelf={shelf}&page={n}
 *
 * Two departures from the reference implementation:
 *
 * 1. It parses only `<title>` and `<author_name>` and throws the rest away. The
 *    feed also carries `<isbn>` and `<book_id>`, and the ISBN is the input to
 *    every print-catalog lookup — without it, print support is not possible.
 *
 * 2. It regexes the XML because service workers have no DOMParser. True, but
 *    `fast-xml-parser` is pure JS, runs anywhere, and doesn't quietly mangle a
 *    title containing a `<` the way the regex approach does.
 *
 * Goodreads retired its API in 2020 and this feed is undocumented, so treat it
 * as something that will break: `goodreads-csv.ts` reads the same shape from an
 * export file and is the fallback when it does.
 */

import { XMLParser } from 'fast-xml-parser';
import type { ShelfEntry } from '../core/types';
import { fetchText } from '../lib/http';
import { toIsbn13 } from '../lib/normalize';

/** Goodreads pages this feed at 100 items regardless of what you ask for. */
const PAGE_SIZE = 100;

/** Safety rail on a runaway shelf; 100 pages is 10,000 books. */
const MAX_PAGES = 100;

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  // Titles are frequently just digits ("1984"); without this they arrive as
  // numbers and every downstream .trim() throws.
  parseTagValue: false,
});

interface RawItem {
  title?: string;
  author_name?: string;
  isbn?: string;
  book_id?: string;
  user_shelves?: string;
  user_date_added?: string;
  book_large_image_url?: string;
  book_medium_image_url?: string;
}

function feedUrl(userId: string, shelf: string, page: number): string {
  return (
    `https://www.goodreads.com/review/list_rss/${encodeURIComponent(userId)}` +
    `?shelf=${encodeURIComponent(shelf)}&page=${page}`
  );
}

function itemsFrom(xml: string): RawItem[] {
  const parsed = parser.parse(xml) as { rss?: { channel?: { item?: RawItem | RawItem[] } } };
  const item = parsed?.rss?.channel?.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

function toEntry(raw: RawItem, fallbackShelf: string): ShelfEntry | undefined {
  const title = raw.title?.trim();
  const author = raw.author_name?.trim();
  const bookId = raw.book_id != null ? String(raw.book_id).trim() : '';
  if (!title || !author || !bookId) return undefined;

  // An empty <user_shelves> means the book sits on the default "read" shelf —
  // Goodreads omits the implicit one rather than naming it.
  const shelves = raw.user_shelves
    ? raw.user_shelves.split(',').map((s) => s.trim()).filter(Boolean)
    : [fallbackShelf];

  const addedAt = raw.user_date_added ? Date.parse(raw.user_date_added) : NaN;

  return {
    id: `goodreads-rss:${bookId}`,
    sourceId: 'goodreads-rss',
    externalId: bookId,
    title,
    author,
    isbn: toIsbn13(raw.isbn),
    shelves,
    addedAt: Number.isNaN(addedAt) ? undefined : addedAt,
    coverUrl: raw.book_large_image_url ?? raw.book_medium_image_url,
  };
}

export interface FetchShelfOptions {
  signal?: AbortSignal;
  /** Called after each page so a long shelf can report progress. */
  onProgress?: (count: number) => void;
}

/**
 * Read one shelf in full, following pagination to the end.
 * Pages are fetched in sequence deliberately — this is someone else's server.
 */
export async function fetchShelf(
  userId: string,
  shelf: string,
  opts: FetchShelfOptions = {},
): Promise<ShelfEntry[]> {
  const entries: ShelfEntry[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const xml = await fetchText(feedUrl(userId, shelf, page), { signal: opts.signal });
    const raw = itemsFrom(xml);
    if (raw.length === 0) break;

    for (const item of raw) {
      const entry = toEntry(item, shelf);
      if (entry) entries.push(entry);
    }

    opts.onProgress?.(entries.length);
    if (raw.length < PAGE_SIZE) break; // short page means last page
  }

  return entries;
}

/**
 * Read several shelves and merge. A book on two selected shelves is one entry
 * with both shelf names, not two rows — deduplicating on `book_id` rather than
 * on a title string is the reason we kept the id.
 */
export async function fetchShelves(
  userId: string,
  shelves: string[],
  opts: FetchShelfOptions = {},
): Promise<ShelfEntry[]> {
  const merged = new Map<string, ShelfEntry>();

  for (const shelf of shelves) {
    for (const entry of await fetchShelf(userId, shelf, opts)) {
      const existing = merged.get(entry.id);
      if (existing) {
        existing.shelves = [...new Set([...existing.shelves, ...entry.shelves])];
      } else {
        merged.set(entry.id, entry);
      }
    }
  }

  return [...merged.values()];
}

/**
 * Every shelf the user has, with counts, from the special `#ALL#` feed.
 * Drives the shelf picker so nobody has to type a shelf name.
 */
export async function listShelves(
  userId: string,
  opts: FetchShelfOptions = {},
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let seen = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const xml = await fetchText(feedUrl(userId, '#ALL#', page), { signal: opts.signal });
    const raw = itemsFrom(xml);
    if (raw.length === 0) break;

    for (const item of raw) {
      const names = item.user_shelves
        ? item.user_shelves.split(',').map((s) => s.trim()).filter(Boolean)
        : ['read'];
      for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
    }

    seen += raw.length;
    opts.onProgress?.(seen);
    if (raw.length < PAGE_SIZE) break;
  }

  return counts;
}

/** Accepts an id, a profile URL, or the `12345678-name` slug form. */
export function parseGoodreadsId(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return (
    trimmed.match(/goodreads\.com\/user\/show\/(\d+)/)?.[1] ??
    trimmed.match(/^(\d+)/)?.[1]
  );
}

/** Exported for tests — parsing a fixture shouldn't require the network. */
export const __test = { itemsFrom, toEntry };
