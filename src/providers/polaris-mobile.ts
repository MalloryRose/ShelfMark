/**
 * Polaris PowerPAC through its mobile catalog, with no session at all.
 *
 * The desktop pages key availability on a result *position* in the session's
 * current search, which forces a per-origin lock and borrows the user's own
 * catalog cookies (see `polaris.ts`). The mobile pages don't need either: sent
 * without cookies, PowerPAC resolves the record id in the path instead of a
 * position, so every request stands alone and lookups can run concurrently.
 * Verified against Denver Public Library (PowerPAC 8.0):
 *
 *   Results/?t={title}&s=TI&l=AU={surname}   up to 25 rows; no counts
 *   Items/1.{cn}.1.0.0                       branches, "(n of m available)"
 *   Items/1.{cn}.1.{branchId}.1              that branch's copies: call numbers
 *
 * Send a session cookie and the same `Items/` URL answers for whichever record
 * the session last opened — so `credentials` must stay at `omit`.
 *
 * A search with exactly one hit redirects to that record's `Title/` page; one
 * with none redirects back to the empty search form.
 */

import type { Format, Holding, HoldingsProvider, ProviderLookupContext } from '../core/types';
import { textOf } from '../lib/html';
import { fetchPage, hostLimiter } from '../lib/http';
import { isMatch } from '../lib/match';
import { authorSurname } from '../lib/normalize';
import { toPrintHoldings, type BranchCopy, type PrintRecord } from './print';

/** Each matched record costs a request for its counts; past three they rarely add a branch. */
const MAX_RECORDS = 3;

/**
 * The mobile pages carry only the library's format label, not a type id.
 * Physical books only: eBook and EAudiobook rows are vendor records the digital
 * providers already report.
 */
const FORMAT_BY_LABEL: Record<string, Format> = {
  Book: 'print',
  'Large Print': 'large-print',
};

export interface MobileRecord {
  /** Control number: Polaris's record id. */
  cn: string;
  title: string;
  author: string;
  formatLabel: string;
}

export interface MobileBranch {
  /** PowerPAC's organisation id; absent when the branch isn't a link. */
  branchId?: string;
  name: string;
  available: number;
  total: number;
}

function groupText(html: string, cls: string): string {
  const m = html.match(new RegExp(`class="${cls}">([\\s\\S]*?)</div>`));
  // Search hits are wrapped in inline <span>s mid-word; textOf would turn each
  // into a space ("Hobbit , or there").
  return m ? textOf((m[1] ?? '').replace(/<\/?span\b[^>]*>/g, '')) : '';
}

function formatLabelOf(html: string): string {
  return html.match(/Formats\/[^"]*"\s+alt="([^"]*)"/)?.[1] ?? '';
}

/** An unrecognised page is "could not tell", never "not held" — so throw. */
function requireMain(html: string, url: string): void {
  if (!html.includes('id="main"')) throw new Error(`Unrecognised Polaris mobile page: ${url}`);
}

export function parseMobileResults(html: string): MobileRecord[] {
  const records: MobileRecord[] = [];
  for (const row of html.split(/<tr[\s>]/).slice(1)) {
    const cn = row.match(/class="nsm-brief-action-link" href="[^"]*\/Title\/(?:\d+\.)*(\d+)"/)?.[1];
    if (!cn) continue;
    records.push({
      cn,
      title: groupText(row, 'nsm-brief-primary-title-group'),
      author: groupText(row, 'nsm-brief-primary-author-group').replace(/^by\s+/, ''),
      formatLabel: formatLabelOf(row),
    });
  }
  return records;
}

/** The `Title/` page a single-hit search lands on. */
export function parseMobileTitle(html: string): MobileRecord | undefined {
  const cn = html.match(/id='plres_(\d+)'/)?.[1];
  if (!cn) return undefined;
  return {
    cn,
    title: groupText(html, 'nsm-summary-primary-title-group'),
    author: groupText(html, 'nsm-summary-primary-author-group').replace(/^by\s+/, ''),
    formatLabel: formatLabelOf(html),
  };
}

/** Empty when the record has no items ("No items available": on order, withdrawn). */
export function parseMobileBranches(html: string): MobileBranch[] {
  const re =
    /class="findit-branch">([\s\S]*?)<\/div>\s*<div class="findit-options">\((\d+) of (\d+) available\)/g;
  return [...html.matchAll(re)].map((m) => {
    const head = m[1] ?? '';
    return {
      branchId: head.match(/\/Items\/(?:\d+\.){3}(\d+)\.\d+"/)?.[1],
      // A " - In" flag follows the link when a copy is in; the counts say the same.
      name: textOf(head.replace(/<span[\s\S]*$/, '')).replace(/\s*-$/, ''),
      available: Number(m[2]),
      total: Number(m[3]),
    };
  });
}

/** `jGN Hobbit - Children's Graphic Novel - <span class="findit-in">Available</span>` */
export function parseMobileCallNumbers(html: string): { callNumber: string; available: boolean }[] {
  return [...html.matchAll(/class="findit-item">([\s\S]*?)<\/div>/g)].flatMap((m) => {
    const raw = m[1] ?? '';
    // Call numbers don't contain " - "; collection names sometimes do, so take the head.
    const callNumber = textOf(raw).split(' - ')[0]?.trim();
    return callNumber ? [{ callNumber, available: raw.includes('class="findit-in"') }] : [];
  });
}

function origin(ctx: ProviderLookupContext): string {
  return ctx.library.baseUrl.replace(/\/+$/, '');
}

function get(url: string, ctx: ProviderLookupContext) {
  return hostLimiter.run(url, () => fetchPage(url, { signal: ctx.signal }));
}

async function search(ctx: ProviderLookupContext): Promise<MobileRecord[]> {
  const params = new URLSearchParams({ t: ctx.work.normalizedTitle, s: 'TI', o: 'RELEVANCE', ls: '1.25.0' });
  // The mobile search takes one field, but its limit accepts a field expression.
  const surname = authorSurname(ctx.work.author);
  if (surname) params.set('l', `AU=${surname}`);

  const url = `${origin(ctx)}/Mobile/Search/Results/?${params}`;
  const { text, finalUrl } = await get(url, ctx);
  const path = new URL(finalUrl).pathname.replace(/\/+$/, '');

  if (path.endsWith('/Mobile/Search')) return [];
  requireMain(text, finalUrl);
  if (path.includes('/Title/')) {
    const record = parseMobileTitle(text);
    if (!record) throw new Error(`Unrecognised Polaris mobile title page: ${finalUrl}`);
    return [record];
  }
  return parseMobileResults(text);
}

async function branchesOf(cn: string, ctx: ProviderLookupContext): Promise<MobileBranch[]> {
  const url = `${origin(ctx)}/Mobile/Search/Items/1.${cn}.1.0.0`;
  const { text } = await get(url, ctx);
  requireMain(text, url);
  return parseMobileBranches(text);
}

/** Best effort: a missing call number must not cost a holding we already know about. */
async function callNumberAt(cn: string, branchId: string, ctx: ProviderLookupContext) {
  try {
    const { text } = await get(`${origin(ctx)}/Mobile/Search/Items/1.${cn}.1.${branchId}.1`, ctx);
    const copies = parseMobileCallNumbers(text);
    return (copies.find((c) => c.available) ?? copies[0])?.callNumber;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    return undefined;
  }
}

export const polarisMobileProvider: HoldingsProvider = {
  id: 'polaris-mobile',
  displayName: 'Polaris PowerPAC (mobile)',
  formats: ['print', 'large-print'] as const,

  async lookup(ctx: ProviderLookupContext): Promise<Holding[]> {
    const matched = (await search(ctx))
      .filter((r) => FORMAT_BY_LABEL[r.formatLabel] && isMatch(ctx.work, r))
      .slice(0, MAX_RECORDS);

    const branchesByCn = new Map<string, MobileBranch[]>();
    const records: PrintRecord[] = [];
    for (const r of matched) {
      const branches = await branchesOf(r.cn, ctx);
      branchesByCn.set(r.cn, branches);
      records.push({
        ref: r.cn,
        format: FORMAT_BY_LABEL[r.formatLabel] as Format,
        copiesAvailable: branches.reduce((n, b) => n + b.available, 0),
        copiesOwned: branches.reduce((n, b) => n + b.total, 0),
        // The permalink runs a control-number search, so it opens the record
        // from the reader's browser whatever their session holds.
        itemUrl: `${origin(ctx)}/view.aspx?cn=${r.cn}`,
      });
    }

    // One call number, for the record toPrintHoldings will show: the one with
    // the most copies in, read at a branch that has one.
    const best = [...records].sort((a, b) => (b.copiesAvailable ?? 0) - (a.copiesAvailable ?? 0))[0];
    const shelf = best && branchesByCn.get(best.ref)?.find((b) => b.available > 0 && b.branchId);
    if (best && shelf?.branchId) best.callNumber = await callNumberAt(best.ref, shelf.branchId, ctx);

    // The summary page already has every branch's counts; no request needed here.
    const copiesOf = async (record: PrintRecord): Promise<BranchCopy[]> =>
      (branchesByCn.get(record.ref) ?? []).flatMap((b) =>
        Array.from({ length: b.total }, (_, i) => ({ branch: b.name, available: i < b.available })),
      );

    return toPrintHoldings(records, ctx, polarisMobileProvider.id, copiesOf);
  },
};
