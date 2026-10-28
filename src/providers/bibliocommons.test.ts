import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryConfig } from '../core/types';
import { bibliocommonsProvider, buildQuery, parseBiblioCommonsKey } from './bibliocommons';
import { fixture, lookupContext, stubFetch, work } from './__fixtures__/helpers';

const SEATTLE: LibraryConfig = {
  id: 'bibliocommons:seattle',
  label: 'Seattle Public',
  providerId: 'bibliocommons',
  baseUrl: 'https://seattle.bibliocommons.com',
  providerKey: 'seattle',
  enabled: true,
};

afterEach(() => vi.unstubAllGlobals());

describe('bibliocommons lookup', () => {
  it('rolls every matching hardback edition into one print holding with branches', async () => {
    const calls = stubFetch([
      ['/bibs/search', fixture('bibliocommons-search-hobbit.json')],
      ['/bibs/S246C395812/availability', fixture('bibliocommons-availability-hobbit.json')],
    ]);

    const holdings = await bibliocommonsProvider.lookup(
      lookupContext(work('The Hobbit', 'J.R.R. Tolkien'), SEATTLE),
    );

    expect(holdings).toHaveLength(1);
    const [h] = holdings;
    expect(h).toMatchObject({
      format: 'print',
      status: 'available',
      // Three Tolkien hardback records (1/24, 0/5, 0/1). The Annotated Hobbit,
      // the Ukrainian translation and a study guide by another author are not
      // this book and must not be counted.
      copiesAvailable: 1,
      copiesOwned: 30,
      holdsQueue: 11,
      callNumber: 'J TOLKIEN',
      itemUrl: 'https://seattle.bibliocommons.com/v2/record/S246C395812',
    });
    expect(h?.branches?.[0]).toEqual({ name: 'Capitol Hill Branch', status: 'available' });
    expect(h?.branches?.find((b) => b.name === 'Ballard Branch')).toEqual({
      name: 'Ballard Branch',
      status: 'unavailable',
      dueDate: '2026-11-05',
    });
    // Only the edition with a copy in costs a branch lookup.
    expect(calls.filter((c) => c.url.includes('/availability'))).toHaveLength(1);
  });

  it('reports a title with every copy out as holdable, without a branch lookup', async () => {
    const calls = stubFetch([['/bibs/search', fixture('bibliocommons-search-dune.json')]]);

    const holdings = await bibliocommonsProvider.lookup(
      lookupContext(work('Dune (Dune, #1)', 'Frank Herbert'), SEATTLE),
    );

    // Ebooks, audiobooks, DVDs and Brian Herbert's graphic novels are all in
    // the response; only the print book survives.
    expect(holdings.map((h) => [h.format, h.status, h.copiesAvailable, h.copiesOwned])).toEqual([
      ['print', 'holdable', 0, 32],
    ]);
    expect(holdings[0]?.branches).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('keeps the holding when the branch lookup fails', async () => {
    stubFetch([['/bibs/search', fixture('bibliocommons-search-hobbit.json')]]);
    const [h] = await bibliocommonsProvider.lookup(
      lookupContext(work('The Hobbit', 'J.R.R. Tolkien'), SEATTLE),
    );
    expect(h?.status).toBe('available');
    expect(h?.branches).toBeUndefined();
  });

  it('never sends cookies to the shared gateway', async () => {
    const calls = stubFetch([['/bibs/search', fixture('bibliocommons-search-dune.json')]]);
    await bibliocommonsProvider.lookup(lookupContext(work('Dune', 'Frank Herbert'), SEATTLE));
    expect(calls[0]?.init?.credentials).toBe('omit');
  });
});

describe('buildQuery', () => {
  it('asks for the ISBN cluster or the title and surname in one request', () => {
    const ctx = lookupContext(work('Dune (Dune, #1)', 'Frank Herbert', ['9780441013593']), SEATTLE);
    expect(buildQuery(ctx)).toBe(
      'identifier:(9780441013593) OR (title:(dune) AND contributor:(herbert))',
    );
  });

  it('falls back to title and surname when there is no ISBN', () => {
    const ctx = lookupContext(work('The Hobbit', 'J.R.R. Tolkien'), SEATTLE);
    expect(buildQuery(ctx)).toBe('(title:(hobbit) AND contributor:(tolkien))');
  });
});

describe('parseBiblioCommonsKey', () => {
  it('accepts a bare key, a host or a full catalog URL', () => {
    expect(parseBiblioCommonsKey('seattle')).toBe('seattle');
    expect(parseBiblioCommonsKey('SEATTLE.bibliocommons.com')).toBe('seattle');
    expect(parseBiblioCommonsKey('https://seattle.bibliocommons.com/v2/search?query=x')).toBe('seattle');
  });

  it('rejects anything else', () => {
    expect(parseBiblioCommonsKey('')).toBeUndefined();
    expect(parseBiblioCommonsKey('https://catalog.denverlibrary.org')).toBeUndefined();
  });
});

describe('bibliocommons detect', () => {
  it('recognises catalogs by host alone', async () => {
    const signal = new AbortController().signal;
    expect(await bibliocommonsProvider.detect?.('https://seattle.bibliocommons.com/v2', signal)).toBe(true);
    expect(await bibliocommonsProvider.detect?.('https://catalog.denverlibrary.org', signal)).toBe(false);
  });
});
