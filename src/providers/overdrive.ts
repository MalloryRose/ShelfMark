/**
 * OverDrive / Libby, via the Thunder API.
 *
 * The reference implementation fetched OverDrive's search *page* and regexed
 * `window.OverDrive.mediaItems` out of the HTML. Thunder is the JSON API Libby
 * itself calls: same data, a fraction of the bytes, and it doesn't break when
 * the front end is restyled. No key, no auth.
 *
 *   GET thunder.api.overdrive.com/v2/libraries/{key}/media?query=…&creator=…
 *
 * One thing to know, verified against the live endpoint: passing an ISBN as
 * `query` returns zero results. Thunder does not index them. So digital lookups
 * go out as title+creator while print catalogs get the ISBN cluster — two
 * strategies, and conflating them silently finds nothing.
 */

import type { Format, Holding, HoldingsProvider, ProviderLookupContext } from '../core/types';
import { fetchJson, hostLimiter } from '../lib/http';
import { authorSurname, normalizeTitle } from '../lib/normalize';

const THUNDER = 'https://thunder.api.overdrive.com/v2';

/** Enough to catch the right edition; beyond this it's all noise. */
const PER_PAGE = 12;

interface ThunderItem {
  id: string;
  title: string;
  subtitle?: string;
  firstCreatorName?: string;
  type?: { id: string; name: string };
  isAvailable?: boolean;
  isHoldable?: boolean;
  isOwned?: boolean;
  availableCopies?: number;
  ownedCopies?: number;
  holdsCount?: number;
  estimatedWaitDays?: number;
  covers?: Record<string, { href?: string } | undefined>;
}

interface ThunderResponse {
  totalItems?: number;
  items?: ThunderItem[];
}

/** Thunder's `type.id` is already close to our vocabulary; map it explicitly anyway. */
function toFormat(typeId: string | undefined): Format | undefined {
  switch (typeId) {
    case 'ebook':
      return 'ebook';
    case 'audiobook':
      return 'audiobook';
    default:
      // magazine, video, etc. Not something you borrow off a to-read shelf.
      return undefined;
  }
}

/**
 * Does this result actually correspond to the book we asked about?
 *
 * This is the check the reference build omits — it pushes every result the
 * search returns straight onto the user's shelf, so a common title yields
 * confident matches for books they never listed. Phase 2 replaces this with a
 * real similarity score; until then, be strict rather than generous.
 */
function isPlausibleMatch(item: ThunderItem, ctx: ProviderLookupContext): boolean {
  const wanted = ctx.work.normalizedTitle;
  const got = normalizeTitle(item.title ?? '');
  if (!wanted || !got) return false;

  // Either title contains the other: catches "Dune" vs "Dune: 50th Anniversary"
  // without accepting "Dune" for "Dune Messiah", which shares no containment.
  const titleAgrees = got === wanted || got.startsWith(`${wanted} `) || wanted.startsWith(`${got} `);
  if (!titleAgrees) return false;

  // The author gate. Cheap, and it's what stops same-title different-book.
  const wantedSurname = authorSurname(ctx.work.author);
  const gotSurname = authorSurname(item.firstCreatorName ?? '');
  return wantedSurname.length > 0 && wantedSurname === gotSurname;
}

function toHolding(item: ThunderItem, ctx: ProviderLookupContext): Holding | undefined {
  const format = toFormat(item.type?.id);
  if (!format) return undefined;

  const available = item.isAvailable === true && (item.availableCopies ?? 0) > 0;
  const owned = item.isOwned !== false && (item.ownedCopies ?? 0) > 0;

  return {
    workId: ctx.work.workId,
    providerId: overdriveProvider.id,
    libraryId: ctx.library.id,
    format,
    status: available ? 'available' : owned ? 'holdable' : 'not-held',
    copiesAvailable: item.availableCopies,
    copiesOwned: item.ownedCopies,
    holdsQueue: item.holdsCount,
    estimatedWaitDays: item.estimatedWaitDays,
    // callNumber and branches stay unset — a digital loan has neither, and
    // faking them with empty strings would lie to the UI.
    itemUrl: `${ctx.library.baseUrl.replace(/\/+$/, '')}/media/${item.id}`,
    coverUrl: item.covers?.cover150Wide?.href,
    fetchedAt: Date.now(),
  };
}

export const overdriveProvider: HoldingsProvider = {
  id: 'overdrive',
  displayName: 'OverDrive / Libby',
  formats: ['ebook', 'audiobook'] as const,

  async lookup(ctx: ProviderLookupContext): Promise<Holding[]> {
    const key = ctx.library.providerKey;
    if (!key) {
      throw new Error(`Library "${ctx.library.label}" has no OverDrive library key`);
    }

    const url =
      `${THUNDER}/libraries/${encodeURIComponent(key)}/media` +
      `?query=${encodeURIComponent(ctx.work.title)}` +
      `&creator=${encodeURIComponent(authorSurname(ctx.work.author))}` +
      `&perPage=${PER_PAGE}&page=1`;

    const body = await hostLimiter.run(url, () =>
      fetchJson<ThunderResponse>(url, { signal: ctx.signal }),
    );

    const holdings: Holding[] = [];
    // One result per format at most: a library can own several editions of the
    // same ebook, and the user only cares about the best one.
    const bestByFormat = new Map<Format, Holding>();

    for (const item of body.items ?? []) {
      if (!isPlausibleMatch(item, ctx)) continue;
      const holding = toHolding(item, ctx);
      if (!holding) continue;

      const existing = bestByFormat.get(holding.format);
      if (!existing || rank(holding) > rank(existing)) {
        bestByFormat.set(holding.format, holding);
      }
    }

    for (const holding of bestByFormat.values()) holdings.push(holding);
    return holdings;
  },
};

/** Available beats holdable; among holds, a shorter queue wins. */
function rank(h: Holding): number {
  if (h.status === 'available') return 1_000_000 + (h.copiesAvailable ?? 0);
  if (h.status === 'holdable') return 1_000 - Math.min(999, h.estimatedWaitDays ?? 999);
  return 0;
}

/**
 * Turn what a user pastes into a Libby library key.
 * Accepts `lapl`, `lapl.overdrive.com`, `https://lapl.overdrive.com/…`.
 */
export function parseOverdriveKey(input: string): string | undefined {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;

  const host = trimmed.match(/(?:https?:\/\/)?([\w-]+)\.overdrive\.com/i);
  if (host) return host[1]!.toLowerCase();

  const bare = trimmed.match(/^([\w-]+)$/);
  return bare ? bare[1]!.toLowerCase() : undefined;
}
