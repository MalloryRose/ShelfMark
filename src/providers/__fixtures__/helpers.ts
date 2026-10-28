/**
 * Shared scaffolding for adapter tests: a `WorkIdentity` built the way the
 * shelf sync builds one, and a `fetch` that serves recorded responses.
 *
 * Fixtures are real responses, recorded 2026-10-28 from Seattle Public Library
 * (BiblioCommons) and Denver Public Library (Polaris PowerPAC 8.0), with
 * `<script>` blocks stripped from the HTML. Re-record when a catalog changes
 * shape — a failing fixture test is how you find out before a user does.
 */

import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import type { LibraryConfig, ProviderLookupContext, WorkIdentity } from '../../core/types';
import { localWorkId, normalizeAuthor, normalizeTitle } from '../../lib/normalize';

export function fixture(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
}

export function work(title: string, author: string, isbns: string[] = []): WorkIdentity {
  return {
    workId: localWorkId(title, author),
    title,
    author,
    normalizedTitle: normalizeTitle(title),
    normalizedAuthor: normalizeAuthor(author),
    isbns,
  };
}

export function lookupContext(w: WorkIdentity, library: LibraryConfig): ProviderLookupContext {
  return { work: w, library, signal: new AbortController().signal };
}

/**
 * Route requests to fixture bodies by URL substring. Unrouted requests fail
 * loudly: an adapter making a call the test didn't expect is itself a finding.
 */
export function stubFetch(routes: [match: string, body: string][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const route = routes.find(([match]) => url.includes(match));
    if (!route) return new Response('unrouted', { status: 599 });
    return new Response(route[1], { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
