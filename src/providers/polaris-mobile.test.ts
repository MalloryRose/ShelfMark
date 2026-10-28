import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryConfig } from '../core/types';
import {
  parseMobileBranches,
  parseMobileCallNumbers,
  parseMobileResults,
  polarisMobileProvider,
} from './polaris-mobile';
import { fixture, lookupContext, stubFetch, work } from './__fixtures__/helpers';

const DENVER: LibraryConfig = {
  id: 'polaris-mobile:denver',
  label: 'Denver Public Library',
  providerId: 'polaris-mobile',
  baseUrl: 'https://catalog.denverlibrary.org',
  enabled: true,
};

const BASE = 'https://catalog.denverlibrary.org';

/**
 * `stubFetch` can't say where a redirect landed, and PowerPAC answers a
 * one-hit or no-hit search only that way.
 */
function stubRedirect(landing: string, body: string, routes: [string, string][] = []) {
  const calls = stubFetch(routes);
  const routed = vi.mocked(fetch).getMockImplementation();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/Mobile/Search/Results/')) return routed!(input, init);
      calls.push({ url, init });
      const res = new Response(body, { status: 200 });
      Object.defineProperty(res, 'url', { value: landing });
      return res;
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('polaris mobile lookup', () => {
  it('merges every matching print record into one holding, with branches and a call number', async () => {
    const calls = stubFetch([
      ['/Mobile/Search/Results/', fixture('polaris-mobile-results-hobbit.html')],
      ['/Items/1.2732099.1.0.0', fixture('polaris-mobile-items-2732099.html')],
      ['/Items/1.1733066.1.0.0', fixture('polaris-mobile-items-1733066.html')],
      ['/Items/1.382002.1.0.0', fixture('polaris-mobile-items-382002.html')],
      ['/Items/1.2732099.1.18.1', fixture('polaris-mobile-branch-2732099-park-hill.html')],
    ]);

    const holdings = await polarisMobileProvider.lookup(
      lookupContext(work('The Hobbit', 'J.R.R. Tolkien'), DENVER),
    );

    expect(holdings).toHaveLength(1);
    const [h] = holdings;
    expect(h).toMatchObject({
      format: 'print',
      status: 'available',
      // 2 of 8 (five branches), 0 of 6 and 0 of 4 at Central. The Annotated
      // Hobbit, El hobbit, the ebooks and the films are in the response and
      // must not be counted.
      copiesAvailable: 2,
      copiesOwned: 18,
      callNumber: 'jGN Hobbit',
      itemUrl: `${BASE}/view.aspx?cn=2732099`,
    });
    expect(h?.branches?.slice(0, 2)).toEqual([
      { name: 'Park Hill', status: 'available' },
      { name: 'Sam Gary', status: 'available' },
    ]);
    expect(h?.branches?.map((b) => b.name)).toContain('Central Library');

    // Search, three summaries, one branch page — and never a cookie, which
    // would make PowerPAC answer for the session's record instead of ours.
    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.init?.credentials === 'omit')).toBe(true);
    expect(calls[0]?.url).toContain('s=TI');
    expect(calls[0]?.url).toContain('l=AU%3Dtolkien');
  });

  it('reads a one-hit search from the title page it redirects to', async () => {
    stubRedirect(
      `${BASE}/Mobile/Search/Title/1.25.1.2355763`,
      fixture('polaris-mobile-title-lessons-in-chemistry.html'),
      [['/Items/1.2355763.1.0.0', fixture('polaris-mobile-items-2355763.html')]],
    );

    const holdings = await polarisMobileProvider.lookup(
      lookupContext(work('Lessons in Chemistry', 'Bonnie Garmus'), DENVER),
    );

    // The large-print record exists but has no items ("No items available").
    expect(holdings).toEqual([
      expect.objectContaining({ format: 'large-print', status: 'not-held', copiesOwned: 0 }),
    ]);
  });

  it('returns nothing when the search bounces back to the empty form', async () => {
    const calls = stubRedirect(`${BASE}/Mobile/Search`, fixture('polaris-mobile-no-results.html'));

    const holdings = await polarisMobileProvider.lookup(
      lookupContext(work('A Book Nobody Wrote', 'Nobody Atall'), DENVER),
    );

    expect(holdings).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('fails rather than report "not held" when the page is not one it knows', async () => {
    stubFetch([['/Mobile/Search/Results/', '<html><body>Service unavailable</body></html>']]);

    await expect(
      polarisMobileProvider.lookup(lookupContext(work('The Hobbit', 'J.R.R. Tolkien'), DENVER)),
    ).rejects.toThrow(/Unrecognised/);
  });
});

describe('polaris mobile parsers', () => {
  it('reads each result row with its record id and format label', () => {
    const rows = parseMobileResults(fixture('polaris-mobile-results-hobbit.html'));
    expect(rows).toHaveLength(21);
    expect(rows[0]).toEqual({
      cn: '2732099',
      title: 'The Hobbit, or there and back again',
      author: expect.stringMatching(/^Tolkien, J\. R\. R\./),
      formatLabel: 'Book',
    });
    expect(rows.find((r) => r.cn === '1040303')).toMatchObject({ author: '', formatLabel: 'Blu-ray Disc' });
  });

  it('reads branch counts and ids from the availability summary', () => {
    expect(parseMobileBranches(fixture('polaris-mobile-items-2732099.html'))).toEqual([
      { branchId: '3', name: 'Central Library', available: 0, total: 4 },
      { branchId: '18', name: 'Park Hill', available: 1, total: 1 },
      { branchId: '8', name: 'Ross-Phyllis Bigpond', available: 0, total: 1 },
      { branchId: '32', name: 'Sam Gary', available: 1, total: 1 },
      { branchId: '10', name: 'Woodbury', available: 0, total: 1 },
    ]);
    expect(parseMobileBranches(fixture('polaris-mobile-items-2355763.html'))).toEqual([]);
  });

  it('reads call numbers and copy status from a branch page', () => {
    expect(parseMobileCallNumbers(fixture('polaris-mobile-branch-2732099-central.html'))).toEqual(
      Array.from({ length: 4 }, () => ({ callNumber: 'jGN Hobbit', available: false })),
    );
    expect(parseMobileCallNumbers(fixture('polaris-mobile-branch-2732099-park-hill.html'))).toEqual([
      { callNumber: 'jGN Hobbit', available: true },
    ]);
  });
});
