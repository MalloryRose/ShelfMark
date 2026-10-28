/**
 * Polaris PowerPAC — print holdings for libraries on Innovative's Polaris ILS.
 *
 * There is no public JSON. Polaris has an official API (PAPI), but it needs a
 * key each library issues, so the public catalog is the only door. And
 * PowerPAC keeps the search in a server session. Verified against Denver
 * Public Library (PowerPAC 8.0):
 *
 *   1. GET {base}/search/searchresults.aspx?…&term=…   stores the search in the session
 *   2. GET {base}/search/components/ajaxResults.aspx?page=1&hpp=20
 *                                                  → HTML fragment of results
 *   3. GET {base}/search/components/ajaxavailability.aspx?pos=N&…
 *                                                  → per-branch table for result N
 *
 * Step 3 ignores the `bibid` it is passed: it reads result N *of the session's
 * current search*. So the three requests must run back to back, cookies
 * included, with no other lookup against the same catalog in between — hence
 * the per-origin session lock below. Without it, two concurrent lookups would
 * silently swap each other's availability.
 *
 * Known cost: the session cookie is the browser's, so a scan replaces the
 * current search in any tab the user has open on that catalog.
 */

import type { Format, Holding, HoldingsProvider, ProviderLookupContext } from '../core/types';
import { textOf } from '../lib/html';
import { fetchPage, hostLimiter, type FetchOptions } from '../lib/http';
import { isMatch } from '../lib/match';
import { authorSurname, toIsbn13 } from '../lib/normalize';
import { toPrintHoldings, type BranchCopy, type PrintRecord } from './print';

const HITS_PER_PAGE = 20;

/**
 * Polaris type-of-material ids, from the format icon filename. Stable across
 * installs because themes reuse the stock icon names; the alt text is the
 * library's own wording, so it's only a fallback.
 */
const FORMAT_BY_TOM_ID: Record<string, Format> = {
  '1': 'print',
  '27': 'large-print',
};

export interface PolarisResult {
  /** 1-based position in the session's current search — what step 3 keys on. */
  pos: number;
  /** Control number: Polaris's record id. */
  cn: string;
  format?: Format;
  title: string;
  author: string;
  isbns: string[];
  callNumber?: string;
  copiesAvailable?: number;
  copiesOwned?: number;
  holdsQueue?: number;
  coverUrl?: string;
}

// ---------------------------------------------------------------------------
// Parsing — pure, and tested against recorded fragments
// ---------------------------------------------------------------------------

function toFormat(tomId: string | undefined, alt: string | undefined): Format | undefined {
  if (tomId) {
    const known = FORMAT_BY_TOM_ID[String(Number(tomId))];
    if (known) return known;
  }
  if (alt && /^\s*large\s*print\s*$/i.test(alt)) return 'large-print';
  if (alt && /^\s*book\s*$/i.test(alt)) return 'print';
  return undefined;
}

/**
 * A brief-display field by its label. Labels are configurable per library, so
 * a missing field is normal; the availability page backs up the counts.
 */
function labelled(block: string, label: string): string | undefined {
  const re = new RegExp(
    `nsm-brief-label[^"]*">\\s*${label}:\\s*</span>([\\s\\S]*?)</div>`,
    'i',
  );
  const match = block.match(re);
  const text = match ? textOf(match[1]!) : '';
  return text || undefined;
}

/** `2 (of 8)` → { available: 2, owned: 8 } */
function parseCopies(text: string | undefined): { available?: number; owned?: number } {
  const match = text?.match(/(\d+)\s*\(\s*of\s*(\d+)\s*\)/i);
  return match ? { available: Number(match[1]), owned: Number(match[2]) } : {};
}

export function parseResults(html: string): PolarisResult[] {
  const results: PolarisResult[] = [];
  // Each result starts at its scroll anchor; the text between two anchors is one record.
  const parts = html.split(/id="__pos-(\d+)"/);

  for (let i = 1; i + 1 < parts.length; i += 2) {
    const pos = Number(parts[i]);
    const block = parts[i + 1]!;

    const cn = block.match(/[?&;]cn=(\d+)/)?.[1];
    const titleHtml = block.match(/nsm-brief-primary-title-group">([\s\S]*?)<\/div>/)?.[1];
    if (!cn || !titleHtml) continue;

    const authorHtml = block.match(/nsm-brief-primary-author-group">([\s\S]*?)<\/div>/)?.[1];
    const formatImg = block.match(/formatid(\d+)\.\w+"[^>]*\balt="([^"]*)"/);
    const isbn = toIsbn13(block.match(/[?&]isbn=([0-9Xx]{10,13})/)?.[1]);
    const copies = parseCopies(labelled(block, 'Available Copies'));
    const holds = labelled(block, 'Current Holds');

    results.push({
      pos,
      cn,
      format: toFormat(formatImg?.[1], formatImg?.[2]),
      title: textOf(titleHtml),
      author: textOf(authorHtml ?? '').replace(/^by\s+/i, ''),
      isbns: isbn ? [isbn] : [],
      callNumber: labelled(block, 'Call Number'),
      copiesAvailable: copies.available,
      copiesOwned: copies.owned,
      holdsQueue: holds !== undefined && /^\d+$/.test(holds) ? Number(holds) : undefined,
      coverUrl: block.match(/<img[^>]*hover__thumbnail[^>]*\bsrc="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&'),
    });
  }
  return results;
}

export interface PolarisAvailability {
  /** The `N.` the page prints before the title — proves which record it describes. */
  pos?: number;
  branches: { branch: string; available: number; owned: number }[];
}

export function parseAvailability(html: string): PolarisAvailability {
  const header = textOf(html.match(/availability__title-container">([\s\S]*?)<\/div>/)?.[1] ?? '');
  const pos = header.match(/^(\d+)\./)?.[1];

  const branches: PolarisAvailability['branches'] = [];
  const re = /<tr class="location">[\s\S]*?<\/i>([^<]+)<\/a>[\s\S]*?\((\d+) of (\d+) available\)/g;
  for (const m of html.matchAll(re)) {
    branches.push({ branch: textOf(m[1]!), available: Number(m[2]), owned: Number(m[3]) });
  }
  return { pos: pos ? Number(pos) : undefined, branches };
}

function toBranchCopies(availability: PolarisAvailability): BranchCopy[] {
  // Polaris summarises per branch rather than per copy; expand so the shared
  // roll-up treats every adapter alike.
  return availability.branches.flatMap(({ branch, available, owned }) =>
    Array.from({ length: Math.max(owned, available) }, (_, i) => ({ branch, available: i < available })),
  );
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Serialises lookups per catalog origin. Module scope is deliberate and safe:
 * it orders requests within one worker lifetime and holds no scan state.
 */
const sessionLocks = new Map<string, Promise<unknown>>();

function withSession<T>(origin: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(origin) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  sessionLocks.set(origin, next);
  void next.finally(() => {
    if (sessionLocks.get(origin) === next) sessionLocks.delete(origin);
  });
  return next;
}

export class PolarisSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolarisSessionError';
  }
}

async function get(url: string, signal: AbortSignal): Promise<string> {
  const opts: FetchOptions = { signal, credentials: 'include' };
  const { text, finalUrl } = await hostLimiter.run(url, () => fetchPage(url, opts));
  // An expired or missing session redirects AJAX endpoints to this page.
  if (/timeoutajax/i.test(finalUrl)) throw new PolarisSessionError('Polaris session expired');
  return text;
}

function base(ctx: ProviderLookupContext): string {
  return ctx.library.baseUrl.replace(/\/+$/, '');
}

function searchTerm(ctx: ProviderLookupContext): string {
  // Keyword search on title words plus surname. Polaris has no OR across
  // ISBNs, and a request per edition is exactly what we must not do.
  return `${ctx.work.normalizedTitle} ${authorSurname(ctx.work.author)}`.trim();
}

async function fetchAvailability(
  ctx: ProviderLookupContext,
  result: Pick<PolarisResult, 'pos' | 'cn'>,
): Promise<PolarisAvailability> {
  const url =
    `${base(ctx)}/search/components/ajaxavailability.aspx` +
    `?fp=1&level=local&morelink=0&pos=${result.pos}&bibid=${result.cn}&displayAeonOnly=0`;
  const availability = parseAvailability(await get(url, ctx.signal));
  if (availability.pos !== undefined && availability.pos !== result.pos) {
    // Something else searched this catalog mid-lookup (most likely the user, in
    // a tab). Better a retried task than another book's branches.
    throw new PolarisSessionError('Polaris session changed during lookup');
  }
  return availability;
}

export const polarisProvider: HoldingsProvider = {
  id: 'polaris',
  displayName: 'Polaris PowerPAC',
  formats: ['print', 'large-print'] as const,

  async detect(catalogUrl: string, signal: AbortSignal): Promise<boolean> {
    const baseUrl = parsePolarisBaseUrl(catalogUrl);
    if (!baseUrl) return false;
    const { text } = await hostLimiter.run(baseUrl, () => fetchPage(baseUrl, { signal }));
    return /Polaris PowerPAC|\/POLARIS\/Public\//i.test(text);
  },

  lookup(ctx: ProviderLookupContext): Promise<Holding[]> {
    const term = searchTerm(ctx);
    if (!term) return Promise.resolve([]);

    return withSession(new URL(base(ctx)).origin, async () => {
      await get(
        `${base(ctx)}/search/searchresults.aspx?type=Keyword&by=KW&sort=RELEVANCE` +
          `&limit=TOM=*&page=0&term=${encodeURIComponent(term)}`,
        ctx.signal,
      );
      const html = await get(
        `${base(ctx)}/search/components/ajaxResults.aspx?page=1&hpp=${HITS_PER_PAGE}`,
        ctx.signal,
      );

      const matched = parseResults(html).filter(
        (r): r is PolarisResult & { format: Format } => r.format !== undefined && isMatch(ctx.work, r),
      );
      const byRef = new Map(matched.map((r) => [String(r.pos), r]));

      // Availability fetched to fill missing counts is reused for branches.
      const fetched = new Map<string, PolarisAvailability>();
      const records: PrintRecord[] = [];
      for (const r of matched) {
        let { copiesAvailable, copiesOwned } = r;
        if (copiesAvailable === undefined || copiesOwned === undefined) {
          // This library's brief display hides the counts; the availability
          // table has them.
          const availability = await fetchAvailability(ctx, r);
          fetched.set(r.cn, availability);
          copiesAvailable = availability.branches.reduce((n, b) => n + b.available, 0);
          copiesOwned = availability.branches.reduce((n, b) => n + b.owned, 0);
        }
        records.push({
          ref: String(r.pos),
          format: r.format,
          copiesAvailable,
          copiesOwned,
          holdsQueue: r.holdsQueue,
          callNumber: r.callNumber,
          // view.aspx?cn= is PowerPAC's permalink; title.aspx needs the
          // session's search context and dead-ends without it.
          itemUrl: `${base(ctx)}/view.aspx?cn=${r.cn}`,
          coverUrl: r.coverUrl,
        });
      }

      return toPrintHoldings(records, ctx, polarisProvider.id, async (record) => {
        const r = byRef.get(record.ref);
        if (!r) return [];
        return toBranchCopies(fetched.get(r.cn) ?? (await fetchAvailability(ctx, r)));
      });
    });
  },
};

/**
 * Turn what a user pastes into a PowerPAC base URL — the part before
 * `/search/`, which is the site root on some installs and `/polaris` on others.
 */
export function parsePolarisBaseUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (!url.hostname.includes('.')) return undefined;

  const path = url.pathname
    .replace(/\/(?:search|view\.aspx|default\.aspx|logon\.aspx|patronaccount)(?:\/.*)?$/i, '')
    .replace(/\/+$/, '');
  return `https://${url.host}${path}`;
}

/** Exposed for tests. */
export const __test = { toBranchCopies };
