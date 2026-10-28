/**
 * What every print adapter does once it has matched records.
 *
 * A library catalog lists each edition it bought as a separate record — Seattle
 * holds *The Hobbit* as three hardback records with 24, 5 and 1 copies. The
 * reader doesn't care which printing is on the shelf, so editions of one format
 * collapse into a single holding with summed copies.
 */

import type { Format, Holding, ProviderLookupContext } from '../core/types';

/** One matched catalog record, normalised by its adapter. */
export interface PrintRecord {
  /** Adapter-private handle, passed back to `fetchBranches`. */
  ref: string;
  format: Format;
  /** Undefined when the catalog didn't say — not the same as zero. */
  copiesAvailable?: number;
  copiesOwned?: number;
  holdsQueue?: number;
  /** BiblioCommons reports copies on order; they make a title holdable. */
  copiesOnOrder?: number;
  callNumber?: string;
  itemUrl: string;
  coverUrl?: string;
}

export interface BranchCopy {
  branch: string;
  available: boolean;
  dueDate?: string;
}

/**
 * Branch lookups cost a request each. Look up only editions with a copy on the
 * shelf, and only this many per work — enough to say where to go.
 */
export const MAX_BRANCH_LOOKUPS = 2;

/** Copy-level rows → one row per branch, branches with a copy in first. */
export function rollUpBranches(copies: readonly BranchCopy[]): NonNullable<Holding['branches']> {
  const byBranch = new Map<string, { available: number; dueDate?: string }>();
  for (const copy of copies) {
    const row = byBranch.get(copy.branch) ?? { available: 0 };
    if (copy.available) row.available++;
    // ISO dates compare correctly as strings; the soonest return is the useful one.
    else if (copy.dueDate && (!row.dueDate || copy.dueDate < row.dueDate)) row.dueDate = copy.dueDate;
    byBranch.set(copy.branch, row);
  }

  return [...byBranch]
    .map(([name, row]) =>
      row.available > 0
        ? { name, status: 'available' }
        : { name, status: 'unavailable', ...(row.dueDate ? { dueDate: row.dueDate } : {}) },
    )
    .sort((a, b) => Number(b.status === 'available') - Number(a.status === 'available'));
}

function sum(values: (number | undefined)[]): number | undefined {
  // One unknown makes the total unknown; reporting a partial sum as the whole
  // would understate what the library owns.
  if (values.some((v) => v === undefined)) return undefined;
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

/** The record a reader should land on: one with a copy in, else the biggest. */
function representative(records: readonly PrintRecord[]): PrintRecord {
  return [...records].sort(
    (a, b) =>
      (b.copiesAvailable ?? 0) - (a.copiesAvailable ?? 0) ||
      (b.copiesOwned ?? 0) - (a.copiesOwned ?? 0),
  )[0]!;
}

/**
 * Matched records → at most one holding per format.
 *
 * `fetchBranches` is only called for formats with a copy available. If it
 * fails the holding still lands without branches: knowing a book is in
 * somewhere beats losing the result over a detail.
 */
export async function toPrintHoldings(
  records: readonly PrintRecord[],
  ctx: ProviderLookupContext,
  providerId: string,
  fetchBranches?: (record: PrintRecord) => Promise<BranchCopy[]>,
): Promise<Holding[]> {
  const byFormat = new Map<Format, PrintRecord[]>();
  for (const record of records) {
    byFormat.set(record.format, [...(byFormat.get(record.format) ?? []), record]);
  }

  const holdings: Holding[] = [];
  for (const [format, group] of byFormat) {
    const copiesAvailable = sum(group.map((r) => r.copiesAvailable));
    const copiesOwned = sum(group.map((r) => r.copiesOwned));
    const onOrder = group.reduce((acc, r) => acc + (r.copiesOnOrder ?? 0), 0);
    const best = representative(group);

    const status: Holding['status'] =
      (copiesAvailable ?? 0) > 0
        ? 'available'
        : (copiesOwned ?? 0) > 0 || onOrder > 0
          ? 'holdable'
          : 'not-held';

    let branches: Holding['branches'];
    if (status === 'available' && fetchBranches) {
      const inStock = group.filter((r) => (r.copiesAvailable ?? 0) > 0).slice(0, MAX_BRANCH_LOOKUPS);
      try {
        const copies = (await Promise.all(inStock.map(fetchBranches))).flat();
        if (copies.length > 0) branches = rollUpBranches(copies);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
    }

    holdings.push({
      workId: ctx.work.workId,
      providerId,
      libraryId: ctx.library.id,
      format,
      status,
      copiesAvailable,
      copiesOwned,
      holdsQueue: sum(group.map((r) => r.holdsQueue)),
      callNumber: best.callNumber,
      branches,
      itemUrl: best.itemUrl,
      coverUrl: best.coverUrl,
      fetchedAt: Date.now(),
    });
  }
  return holdings;
}
