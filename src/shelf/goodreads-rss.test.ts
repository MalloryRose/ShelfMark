import { describe, expect, it } from 'vitest';
import { __test, parseGoodreadsId } from './goodreads-rss';

const { itemsFrom, toEntry } = __test;

/**
 * Shaped after a real `list_rss` response — CDATA wrapping, an ISBN-10, a book
 * whose title is bare digits, and an entry with empty `<user_shelves>`.
 */
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Reader's bookshelf: to-read</title>
    <item>
      <title><![CDATA[Dune (Dune, #1)]]></title>
      <book_id>234225</book_id>
      <isbn>0441013597</isbn>
      <author_name><![CDATA[Frank Herbert]]></author_name>
      <user_shelves><![CDATA[to-read, sci-fi]]></user_shelves>
      <user_date_added><![CDATA[Wed, 12 Mar 2025 09:14:22 -0700]]></user_date_added>
      <book_large_image_url><![CDATA[https://images.gr-assets.com/books/1.jpg]]></book_large_image_url>
    </item>
    <item>
      <title><![CDATA[1984]]></title>
      <book_id>5470</book_id>
      <isbn></isbn>
      <author_name><![CDATA[George Orwell]]></author_name>
      <user_shelves></user_shelves>
    </item>
    <item>
      <title><![CDATA[Missing Author]]></title>
      <book_id>999</book_id>
      <author_name></author_name>
    </item>
  </channel>
</rss>`;

describe('itemsFrom', () => {
  it('reads every item from the channel', () => {
    expect(itemsFrom(FIXTURE)).toHaveLength(3);
  });

  it('returns a single item as an array, not a bare object', () => {
    // fast-xml-parser collapses a lone <item> — callers must not have to care.
    const single = FIXTURE.replace(/<item>[\s\S]*<\/item>/, `
      <item><title><![CDATA[Solo]]></title><book_id>1</book_id>
      <author_name><![CDATA[A. Writer]]></author_name></item>`);
    expect(Array.isArray(itemsFrom(single))).toBe(true);
    expect(itemsFrom(single)).toHaveLength(1);
  });

  it('returns empty for a feed with no items', () => {
    expect(itemsFrom('<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('toEntry', () => {
  const items = itemsFrom(FIXTURE);

  it('captures the ISBN as ISBN-13 — the field print lookups depend on', () => {
    const entry = toEntry(items[0]!, 'to-read');
    expect(entry?.isbn).toBe('9780441013593');
  });

  it('keeps the Goodreads book id for stable deduplication', () => {
    const entry = toEntry(items[0]!, 'to-read');
    expect(entry?.externalId).toBe('234225');
    expect(entry?.id).toBe('goodreads-rss:234225');
  });

  it('splits multiple shelves', () => {
    expect(toEntry(items[0]!, 'to-read')?.shelves).toEqual(['to-read', 'sci-fi']);
  });

  it('parses the added date', () => {
    expect(toEntry(items[0]!, 'to-read')?.addedAt).toBe(
      Date.parse('Wed, 12 Mar 2025 09:14:22 -0700'),
    );
  });

  it('falls back to the requested shelf when user_shelves is empty', () => {
    expect(toEntry(items[1]!, 'to-read')?.shelves).toEqual(['to-read']);
  });

  it('keeps a numeric title as a string', () => {
    // "1984" parses as a number unless the parser is configured not to, and
    // every downstream string method then throws.
    const entry = toEntry(items[1]!, 'to-read');
    expect(entry?.title).toBe('1984');
    expect(typeof entry?.title).toBe('string');
  });

  it('leaves isbn undefined rather than empty-string when absent', () => {
    expect(toEntry(items[1]!, 'to-read')?.isbn).toBeUndefined();
  });

  it('skips rows missing a required field', () => {
    expect(toEntry(items[2]!, 'to-read')).toBeUndefined();
  });
});

describe('parseGoodreadsId', () => {
  it('accepts the forms a user might paste', () => {
    expect(parseGoodreadsId('https://www.goodreads.com/user/show/12345678-jane')).toBe('12345678');
    expect(parseGoodreadsId('goodreads.com/user/show/12345678')).toBe('12345678');
    expect(parseGoodreadsId('12345678-jane')).toBe('12345678');
    expect(parseGoodreadsId('12345678')).toBe('12345678');
  });

  it('rejects input with no id in it', () => {
    expect(parseGoodreadsId('')).toBeUndefined();
    expect(parseGoodreadsId('jane')).toBeUndefined();
  });
});
