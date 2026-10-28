/**
 * BiblioCommons — print holdings for many of the largest North American
 * public library systems.
 *
 * The catalog front end is a client of a JSON gateway shared by every
 * BiblioCommons library, so there is no HTML to parse. Verified live against
 * Seattle Public Library:
 *
 *   GET gateway.bibliocommons.com/v2/libraries/{key}/bibs/search
 *       ?searchType=bl&view=grouped&limit=20&query=<boolean query>
 *   → entities.bibs[id] = { briefInfo: { title, authors, format, callNumber,
 *       isbns, jacket }, availability: { availableCopies, totalCopies,
 *       heldCopies, onOrderCopies, libraryUseOnly } }
 *
 *   GET …/bibs/{id}/availability
 *   → entities.bibItems[itemId] = { branchName, callNumber, dueDate,
 *       availability: { statusType: 'AVAILABLE' | 'UNAVAILABLE' } }
 *
 * `searchType=bl` takes Solr-style field queries, which lets one request ask
 * for the ISBN cluster *or* title+author — editions catalogued under a
 * different title still match by ISBN, and editions with no ISBN in common
 * still match by name.
 */

import type { Format, Holding, HoldingsProvider, ProviderLookupContext } from '../core/types';
import { fetchJson, hostLimiter } from '../lib/http';
import { isMatch } from '../lib/match';
import { authorSurname } from '../lib/normalize';
import { toPrintHoldings, type BranchCopy, type PrintRecord } from './print';

export const BIBLIOCOMMONS_GATEWAY = 'https://gateway.bibliocommons.com/v2';

/** Enough to cover every edition of a popular title; beyond that it's noise. */
const PER_PAGE = 20;

/** Solr clauses get slow and get truncated past a point; the first editions are the likely ones. */
const MAX_QUERY_ISBNS = 20;

interface BcBib {
  id: string;
  briefInfo?: {
    title?: string;
    authors?: string[];
    format?: string;
    callNumber?: string;
    isbns?: string[];
    jacket?: { medium?: string | null };
  };
  availability?: {
    availableCopies?: number | null;
    totalCopies?: number | null;
    heldCopies?: number | null;
    onOrderCopies?: number | null;
    libraryUseOnly?: boolean;
  };
}

interface BcSearchResponse {
  entities?: { bibs?: Record<string, BcBib> };
}

interface BcAvailabilityResponse {
  entities?: {
    bibItems?: Record<
      string,
      {
        branchName?: string;
        branch?: { name?: string };
        dueDate?: string | null;
        availability?: { statusType?: string };
      }
    >;
  };
}

/**
 * Print only. BiblioCommons also lists a library's OverDrive titles, but the
 * OverDrive provider already reports those with queue depth and wait times;
 * reporting them twice would show every ebook as two rows.
 */
function toFormat(code: string | undefined): Format | undefined {
  switch (code) {
    case 'BK':
      return 'print';
    case 'LPRINT':
      return 'large-print';
    default:
      // BOOK_CD, GRAPHIC_NOVEL, DVD, … — a different thing from the book on the shelf.
      return undefined;
  }
}

/** Solr metacharacters would turn a title into a syntax error. */
function solrTerms(text: string): string {
  return text.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function buildQuery(ctx: ProviderLookupContext): string {
  const clauses: string[] = [];
  const isbns = ctx.work.isbns.slice(0, MAX_QUERY_ISBNS);
  if (isbns.length > 0) clauses.push(`identifier:(${isbns.join(' OR ')})`);

  const title = solrTerms(ctx.work.normalizedTitle);
  const surname = solrTerms(authorSurname(ctx.work.author));
  if (title && surname) clauses.push(`(title:(${title}) AND contributor:(${surname}))`);

  return clauses.join(' OR ');
}

function libraryKey(ctx: ProviderLookupContext): string {
  const key = ctx.library.providerKey;
  if (!key) throw new Error(`Library "${ctx.library.label}" has no BiblioCommons library key`);
  return key;
}

function toRecord(bib: BcBib, ctx: ProviderLookupContext): PrintRecord | undefined {
  const format = toFormat(bib.briefInfo?.format);
  if (!format) return undefined;

  const a = bib.availability ?? {};
  // Reference copies are "available" in the catalog's sense and useless to a
  // reader planning to borrow; counting them would send people for nothing.
  if (a.libraryUseOnly) return undefined;

  return {
    ref: bib.id,
    format,
    copiesAvailable: a.availableCopies ?? undefined,
    copiesOwned: a.totalCopies ?? undefined,
    holdsQueue: a.heldCopies ?? undefined,
    copiesOnOrder: a.onOrderCopies ?? undefined,
    callNumber: bib.briefInfo?.callNumber?.trim() || undefined,
    itemUrl: `${ctx.library.baseUrl.replace(/\/+$/, '')}/v2/record/${encodeURIComponent(bib.id)}`,
    coverUrl: bib.briefInfo?.jacket?.medium ?? undefined,
  };
}

async function fetchBranches(record: PrintRecord, ctx: ProviderLookupContext): Promise<BranchCopy[]> {
  const url = `${BIBLIOCOMMONS_GATEWAY}/libraries/${encodeURIComponent(libraryKey(ctx))}/bibs/${encodeURIComponent(record.ref)}/availability`;
  const body = await hostLimiter.run(url, () =>
    fetchJson<BcAvailabilityResponse>(url, { signal: ctx.signal }),
  );

  return Object.values(body.entities?.bibItems ?? {}).flatMap((item) => {
    const branch = item.branchName ?? item.branch?.name;
    if (!branch) return [];
    return [
      {
        branch,
        // statusType collapses CHECKED_OUT, IN_TRANSIT, ON_HOLD… into the one
        // question that matters: can someone walk in and take it?
        available: item.availability?.statusType === 'AVAILABLE',
        dueDate: item.dueDate ?? undefined,
      },
    ];
  });
}

export const bibliocommonsProvider: HoldingsProvider = {
  id: 'bibliocommons',
  displayName: 'BiblioCommons',
  formats: ['print', 'large-print'] as const,

  async detect(catalogUrl: string): Promise<boolean> {
    // Every BiblioCommons catalog lives on a subdomain of this one host.
    try {
      return /^[\w-]+\.bibliocommons\.com$/i.test(new URL(catalogUrl).hostname);
    } catch {
      return false;
    }
  },

  async lookup(ctx: ProviderLookupContext): Promise<Holding[]> {
    const query = buildQuery(ctx);
    if (!query) return [];

    const url =
      `${BIBLIOCOMMONS_GATEWAY}/libraries/${encodeURIComponent(libraryKey(ctx))}/bibs/search` +
      `?searchType=bl&view=grouped&limit=${PER_PAGE}&query=${encodeURIComponent(query)}`;

    const body = await hostLimiter.run(url, () =>
      fetchJson<BcSearchResponse>(url, { signal: ctx.signal }),
    );

    const records: PrintRecord[] = [];
    for (const bib of Object.values(body.entities?.bibs ?? {})) {
      const info = bib.briefInfo;
      if (!info?.title) continue;
      const matched = isMatch(ctx.work, {
        title: info.title,
        author: info.authors?.[0] ?? '',
        isbns: info.isbns,
      });
      if (!matched) continue;
      const record = toRecord(bib, ctx);
      if (record) records.push(record);
    }

    return toPrintHoldings(records, ctx, bibliocommonsProvider.id, (r) => fetchBranches(r, ctx));
  },
};

/**
 * Turn what a user pastes into a BiblioCommons library key.
 * Accepts `seattle`, `seattle.bibliocommons.com`, `https://seattle.bibliocommons.com/v2/…`.
 */
export function parseBiblioCommonsKey(input: string): string | undefined {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;

  const host = trimmed.match(/^(?:https?:\/\/)?([\w-]+)\.bibliocommons\.com(?:[/?#]|$)/i);
  if (host) return host[1]!.toLowerCase();

  const bare = trimmed.match(/^([\w-]+)$/);
  return bare ? bare[1]!.toLowerCase() : undefined;
}
