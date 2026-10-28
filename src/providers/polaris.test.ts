import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryConfig } from '../core/types';
import { parseAvailability, parsePolarisBaseUrl, parseResults, polarisProvider } from './polaris';
import { fixture, lookupContext, stubFetch, work } from './__fixtures__/helpers';

const DENVER: LibraryConfig = {
  id: 'polaris:catalog.denverlibrary.org',
  label: 'Denver Public',
  providerId: 'polaris',
  baseUrl: 'https://catalog.denverlibrary.org',
  enabled: true,
};

afterEach(() => vi.unstubAllGlobals());

function denverRoutes(): [string, string][] {
  return [
    ['/search/searchresults.aspx', '<html></html>'],
    ['/search/components/ajaxResults.aspx', fixture('polaris-results-hobbit.html')],
    ['/search/components/ajaxavailability.aspx', fixture('polaris-availability-hobbit.html')],
  ];
}

describe('parseResults', () => {
  const results = parseResults(fixture('polaris-results-hobbit.html'));

  it('reads every result on the page', () => {
    expect(results).toHaveLength(20);
  });

  it('reads the labelled brief-display fields', () => {
    expect(results.find((r) => r.cn === '2732099')).toMatchObject({
      pos: 3,
      format: 'print',
      isbns: ['9780063447998'],
      callNumber: 'jGN Hobbit',
      copiesAvailable: 2,
      copiesOwned: 8,
      holdsQueue: 0,
    });
  });

  it('leaves non-book formats unmapped rather than guessing', () => {
    const formats = new Set(results.filter((r) => r.format === undefined).map((r) => r.callNumber));
    expect(formats).toContain('eBook');
    expect(formats).toContain('BLU-RAY H');
  });

  it('decodes entities in titles', () => {
    expect(results[0]?.title).toBe("J.R.R. Tolkien's The hobbit");
  });
});

describe('parseAvailability', () => {
  it('reads per-branch counts and which result the page describes', () => {
    const a = parseAvailability(fixture('polaris-availability-hobbit.html'));
    expect(a.pos).toBe(3);
    expect(a.branches).toContainEqual({ branch: 'Park Hill', available: 1, owned: 1 });
    expect(a.branches).toContainEqual({ branch: 'Central Library', available: 0, owned: 4 });
  });
});

describe('polaris lookup', () => {
  it('keeps only the matching print record and finds the branches with a copy in', async () => {
    const calls = stubFetch(denverRoutes());

    const holdings = await polarisProvider.lookup(
      lookupContext(work('The Hobbit', 'J.R.R. Tolkien'), DENVER),
    );

    // Gray's study guide, the encyclopedia and Dixon's illustrated adaptation
    // all mention the Hobbit; none of them is the book.
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({
      format: 'print',
      status: 'available',
      copiesAvailable: 2,
      copiesOwned: 8,
      itemUrl: 'https://catalog.denverlibrary.org/view.aspx?cn=2732099',
    });
    expect(holdings[0]?.branches?.slice(0, 2)).toEqual([
      { name: 'Park Hill', status: 'available' },
      { name: 'Sam Gary', status: 'available' },
    ]);

    // The session protocol, in order, with cookies.
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/search/searchresults.aspx',
      '/search/components/ajaxResults.aspx',
      '/search/components/ajaxavailability.aspx',
    ]);
    expect(calls.every((c) => c.init?.credentials === 'include')).toBe(true);
    expect(calls[2]?.url).toContain('pos=3');
  });

  it('never interleaves two lookups against one catalog', async () => {
    const calls = stubFetch(denverRoutes());
    const hobbit = lookupContext(work('The Hobbit', 'J.R.R. Tolkien'), DENVER);

    await Promise.all([polarisProvider.lookup(hobbit), polarisProvider.lookup(hobbit)]);

    const steps = calls.map((c) => new URL(c.url).pathname.split('/').pop());
    expect(steps).toEqual([
      'searchresults.aspx',
      'ajaxResults.aspx',
      'ajaxavailability.aspx',
      'searchresults.aspx',
      'ajaxResults.aspx',
      'ajaxavailability.aspx',
    ]);
  });

  it('refuses branch data that describes a different result', async () => {
    stubFetch([
      ['/search/searchresults.aspx', '<html></html>'],
      ['/search/components/ajaxResults.aspx', fixture('polaris-results-hobbit.html')],
      [
        '/search/components/ajaxavailability.aspx',
        fixture('polaris-availability-hobbit.html').replace(
          /(&nbsp;\s*)3\.\s/,
          (_, before: string) => `${before}7. `,
        ),
      ],
    ]);

    const [h] = await polarisProvider.lookup(
      lookupContext(work('The Hobbit', 'J.R.R. Tolkien'), DENVER),
    );
    // The counts from the results page still stand; the branches don't.
    expect(h?.status).toBe('available');
    expect(h?.branches).toBeUndefined();
  });

  it('finds nothing, honestly, for a book the catalog does not have', async () => {
    stubFetch(denverRoutes());
    const holdings = await polarisProvider.lookup(
      lookupContext(work('Piranesi', 'Susanna Clarke'), DENVER),
    );
    expect(holdings).toEqual([]);
  });
});

describe('parsePolarisBaseUrl', () => {
  it('keeps the install path and drops the page', () => {
    expect(parsePolarisBaseUrl('catalog.denverlibrary.org')).toBe('https://catalog.denverlibrary.org');
    expect(
      parsePolarisBaseUrl('https://catalog.denverlibrary.org/search/searchresults.aspx?term=x'),
    ).toBe('https://catalog.denverlibrary.org');
    expect(parsePolarisBaseUrl('https://lib.example.org/polaris/default.aspx')).toBe(
      'https://lib.example.org/polaris',
    );
  });

  it('rejects input that is not a host', () => {
    expect(parsePolarisBaseUrl('')).toBeUndefined();
    expect(parsePolarisBaseUrl('denver')).toBeUndefined();
  });
});
