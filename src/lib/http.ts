/**
 * Network access, shaped by the MV3 service-worker lifecycle.
 *
 * Chrome terminates an extension service worker when a `fetch()` response takes
 * more than 30 seconds to arrive. That is a hard kill — no catch block runs, no
 * progress is committed. So every request here aborts comfortably *below* that
 * line, and our own AbortController always wins the race.
 *
 * (The extension this project learns from set its timeout to 60s, above the
 * threshold, so a slow catalog took the whole scan down with it.)
 */

/** Must stay under Chrome's 30s fetch kill threshold. */
export const MAX_FETCH_MS = 20_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `${status} for ${new URL(url).host}`);
    this.name = 'HttpError';
  }

  /** 429 and 5xx are worth retrying; 4xx generally is not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class TimeoutError extends Error {
  constructor(readonly url: string) {
    super(`Timed out after ${MAX_FETCH_MS}ms: ${new URL(url).host}`);
    this.name = 'TimeoutError';
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * `include` for catalogs that keep search state in a server session (Polaris
   * PowerPAC). Everything else is stateless and should not send cookies.
   */
  credentials?: RequestCredentials;
}

async function request(url: string, opts: FetchOptions = {}): Promise<Response> {
  const timeoutMs = Math.min(opts.timeoutMs ?? MAX_FETCH_MS, MAX_FETCH_MS);
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), timeoutMs);

  // Caller cancellation (scan cancelled) and our timeout are separate reasons
  // to stop; either should abort the request.
  const signals = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;

  try {
    const res = await fetch(url, {
      signal: signals,
      headers: opts.headers,
      credentials: opts.credentials ?? 'omit',
    });
    if (!res.ok) throw new HttpError(res.status, url);
    return res;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (opts.signal?.aborted) throw err; // genuine cancellation — propagate as-is
    if (timer.signal.aborted) throw new TimeoutError(url);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJson<T>(url: string, opts?: FetchOptions): Promise<T> {
  const res = await request(url, opts);
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts?: FetchOptions): Promise<string> {
  const res = await request(url, opts);
  return res.text();
}

/** As `fetchText`, plus where redirects landed — some catalogs signal an expired session only that way. */
export async function fetchPage(
  url: string,
  opts?: FetchOptions,
): Promise<{ text: string; finalUrl: string }> {
  const res = await request(url, opts);
  return { text: await res.text(), finalUrl: res.url || url };
}

// ---------------------------------------------------------------------------
// Per-host politeness
// ---------------------------------------------------------------------------

/**
 * Caps in-flight requests per host and spaces them out.
 *
 * Hundreds of rapid requests to one library catalog looks like an attack and
 * gets you blocked. This is the difference between a tool a library tolerates
 * and one it firewalls.
 */
export class HostLimiter {
  private active = new Map<string, number>();
  private lastStart = new Map<string, number>();
  private waiting: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent = 4,
    private readonly minGapMs = 120,
  ) {}

  async run<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const host = new URL(url).host;
    await this.acquire(host);
    try {
      return await fn();
    } finally {
      this.release(host);
    }
  }

  private async acquire(host: string): Promise<void> {
    while ((this.active.get(host) ?? 0) >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    const gap = Date.now() - (this.lastStart.get(host) ?? 0);
    if (gap < this.minGapMs) {
      await new Promise((r) => setTimeout(r, this.minGapMs - gap));
    }
    this.active.set(host, (this.active.get(host) ?? 0) + 1);
    this.lastStart.set(host, Date.now());
  }

  private release(host: string): void {
    this.active.set(host, Math.max(0, (this.active.get(host) ?? 1) - 1));
    this.waiting.shift()?.();
  }
}

export const hostLimiter = new HostLimiter();

/** Full jitter, so retries after a shared outage don't arrive in lockstep. */
export function backoffMs(attempt: number, baseMs = 1_000, capMs = 60_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.random() * ceiling;
}
