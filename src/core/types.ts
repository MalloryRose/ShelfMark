/**
 * The vocabulary every layer agrees on.
 *
 * The single most important rule in this file: no provider's response shape is
 * allowed past `Holding`. OverDrive's `firstCreatorName` and a BiblioCommons
 * call number both land here, normalised, or they don't land at all.
 */

export type Format = 'print' | 'ebook' | 'audiobook' | 'large-print';

export type HoldingStatus =
  /** On the shelf / a copy is loanable right now. */
  | 'available'
  /** Owned, all copies out — the user can queue for it. */
  | 'holdable'
  /** This library does not own it in this format. */
  | 'not-held';

/** One row as it arrives from a reading-list source, before any resolution. */
export interface ShelfEntry {
  /** Stable key: `${sourceId}:${externalId}`. */
  id: string;
  sourceId: 'goodreads-rss' | 'goodreads-csv';
  /** The source's own id — Goodreads `book_id`. Worth keeping: it survives retitling. */
  externalId: string;
  title: string;
  author: string;
  /** ISBN-13 where we could derive one. The reference build discarded this. */
  isbn?: string;
  shelves: string[];
  addedAt?: number;
  coverUrl?: string;
}

/**
 * A book as a *work*, not an edition — the join key everything else hangs off.
 *
 * `isbns` is the edition cluster. A library owns whichever printing it bought,
 * so matching against a single ISBN finds almost nothing; matching against the
 * cluster is what makes print lookups viable at all.
 */
export interface WorkIdentity {
  /** Open Library work key (`OL893414W`), or `local:<slug>` before resolution. */
  workId: string;
  title: string;
  author: string;
  /** Comparison form — see lib/normalize.ts. Never displayed. */
  normalizedTitle: string;
  normalizedAuthor: string;
  isbns: string[];
  coverUrl?: string;
  /** Unset until the Open Library resolver has run (phase 2). */
  resolvedAt?: number;
}

export interface LibraryConfig {
  id: string;
  /** The user's own words: "Seattle Public". Shown in the UI, never derived from a URL. */
  label: string;
  providerId: string;
  /** Origin we need permission for, e.g. `https://seattle.bibliocommons.com`. */
  baseUrl: string;
  /**
   * Provider-specific handle. For OverDrive this is the Libby library key
   * (`lapl`), which is not always the subdomain — hence a separate field.
   */
  providerKey?: string;
  enabled: boolean;
}

/** What a provider returns, and the only book shape the UI ever sees. */
export interface Holding {
  workId: string;
  providerId: string;
  libraryId: string;
  format: Format;
  status: HoldingStatus;
  copiesAvailable?: number;
  copiesOwned?: number;
  holdsQueue?: number;
  estimatedWaitDays?: number;
  /** Print only. `SCI-FIC HERBERT 2019` — meaningless for a digital loan. */
  callNumber?: string;
  /** Print only. Digital has no branches. */
  branches?: { name: string; status: string; dueDate?: string }[];
  itemUrl: string;
  coverUrl?: string;
  /** Drives cache TTL. Digital availability moves faster than print. */
  fetchedAt: number;
}

/** Composite key for a holding row. */
export function holdingKey(h: Pick<Holding, 'workId' | 'libraryId' | 'format'>): string {
  return `${h.workId}::${h.libraryId}::${h.format}`;
}

// ---------------------------------------------------------------------------
// Scan queue
// ---------------------------------------------------------------------------

export type ScanTaskState = 'pending' | 'done' | 'failed';

/**
 * One (work × library) lookup. Persisted *before* any network call, so a
 * terminated service worker resumes instead of restarting.
 */
export interface ScanTask {
  id: string;
  runId: string;
  workId: string;
  libraryId: string;
  providerId: string;
  state: ScanTaskState;
  attempts: number;
  /** Epoch ms; a backed-off task is skipped until now() passes this. */
  nextAttemptAt: number;
  error?: string;
}

export type ScanStatus = 'running' | 'complete' | 'cancelled' | 'failed';

export interface ScanRun {
  id: string;
  source: 'manual' | 'auto';
  status: ScanStatus;
  startedAt: number;
  finishedAt?: number;
  total: number;
  done: number;
  failed: number;
  /** Providers that tripped their circuit breaker during this run. */
  degradedProviders: string[];
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderLookupContext {
  work: WorkIdentity;
  library: LibraryConfig;
  signal: AbortSignal;
}

/**
 * Every source of availability implements this — digital or print, JSON API or
 * scraped markup. Adding a catalog platform must never reach the UI.
 */
export interface HoldingsProvider {
  id: string;
  displayName: string;
  /** Formats this provider can ever report. Used to skip pointless lookups. */
  formats: readonly Format[];
  /** Fingerprint an unknown catalog URL, for the "paste your catalog" fallback. */
  detect?(catalogUrl: string, signal: AbortSignal): Promise<boolean>;
  lookup(ctx: ProviderLookupContext): Promise<Holding[]>;
}
