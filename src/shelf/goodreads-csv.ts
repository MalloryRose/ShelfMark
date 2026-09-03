/**
 * Goodreads CSV export — the insurance policy.
 *
 * The RSS feed is undocumented and Goodreads has already retired one API. This
 * reads the same shape from `goodreads_library_export.csv`, which also works
 * for private profiles the feed refuses to serve. Shipping it at launch rather
 * than as a later fix is the difference between an outage and an inconvenience.
 *
 * Export lives at: goodreads.com → My Books → Import and export → Export Library
 */

import Papa from 'papaparse';
import type { ShelfEntry } from '../core/types';
import { toIsbn13 } from '../lib/normalize';

/**
 * Goodreads wraps ISBNs as `="0441013597"` so spreadsheets don't eat the
 * leading zero. Unwrap before validating or every ISBN fails.
 */
function unwrapIsbn(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/^="?|"?$/g, '').trim() || undefined;
}

interface CsvRow {
  'Book Id'?: string;
  Title?: string;
  Author?: string;
  ISBN?: string;
  ISBN13?: string;
  'Exclusive Shelf'?: string;
  Bookshelves?: string;
  'Date Added'?: string;
}

export interface CsvParseResult {
  entries: ShelfEntry[];
  /** Rows we could not use, for an honest "imported 340 of 347" message. */
  skipped: number;
}

export function parseGoodreadsCsv(csv: string): CsvParseResult {
  const { data } = Papa.parse<CsvRow>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const entries: ShelfEntry[] = [];
  let skipped = 0;

  for (const row of data) {
    const bookId = row['Book Id']?.trim();
    const title = row.Title?.trim();
    const author = row.Author?.trim();

    if (!bookId || !title || !author) {
      skipped++;
      continue;
    }

    // "Exclusive Shelf" is the read/currently-reading/to-read state;
    // "Bookshelves" holds the user's own tags. Both are shelves to us.
    const shelves = new Set<string>();
    const exclusive = row['Exclusive Shelf']?.trim();
    if (exclusive) shelves.add(exclusive);
    for (const s of row.Bookshelves?.split(',') ?? []) {
      const name = s.trim();
      if (name) shelves.add(name);
    }
    if (shelves.size === 0) shelves.add('to-read');

    const added = row['Date Added'] ? Date.parse(row['Date Added']) : NaN;

    entries.push({
      id: `goodreads-csv:${bookId}`,
      sourceId: 'goodreads-csv',
      externalId: bookId,
      title,
      author,
      // ISBN13 column first; fall back to the 10 and let toIsbn13 convert.
      isbn: toIsbn13(unwrapIsbn(row.ISBN13)) ?? toIsbn13(unwrapIsbn(row.ISBN)),
      shelves: [...shelves],
      addedAt: Number.isNaN(added) ? undefined : added,
    });
  }

  return { entries, skipped };
}
