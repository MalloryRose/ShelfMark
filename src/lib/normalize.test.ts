import { describe, expect, it } from 'vitest';
import {
  authorSurname,
  localWorkId,
  normalizeAuthor,
  normalizeTitle,
  toIsbn13,
} from './normalize';

describe('normalizeTitle', () => {
  it('strips series numbering in either bracket style', () => {
    expect(normalizeTitle('Dune (Dune, #1)')).toBe('dune');
    expect(normalizeTitle('Dune [Dune Chronicles #1]')).toBe('dune');
  });

  it('strips edition and format notes', () => {
    expect(normalizeTitle('Project Hail Mary (Unabridged)')).toBe('project hail mary');
    expect(normalizeTitle('Beloved [Large Print]')).toBe('beloved');
  });

  it('drops a subtitle so catalog and shelf agree', () => {
    expect(normalizeTitle('Educated: A Memoir')).toBe('educated');
    expect(normalizeTitle('Educated')).toBe('educated');
  });

  it('keeps a subtitle when dropping it would leave nothing useful', () => {
    // A four-character floor: "1984: The Novel" must not become "1984"-only by
    // accident, but "Ex: A Story" must not collapse to "ex".
    expect(normalizeTitle('Ex: A Story of Leaving')).toBe('ex a story of leaving');
  });

  it('folds articles, diacritics, ampersands and punctuation', () => {
    expect(normalizeTitle('The Émigré')).toBe('emigre');
    expect(normalizeTitle('Sense & Sensibility')).toBe('sense and sensibility');
    expect(normalizeTitle("O'Brien's Luck")).toBe('obriens luck');
  });

  it('agrees across the shapes the same book actually appears in', () => {
    const forms = [
      'The Handmaid’s Tale',
      'The Handmaid\'s Tale (The Handmaid\'s Tale, #1)',
      'the handmaids tale',
    ];
    const [first, ...rest] = forms.map(normalizeTitle);
    for (const other of rest) expect(other).toBe(first);
  });
});

describe('normalizeAuthor', () => {
  it('un-inverts catalog-style names', () => {
    expect(normalizeAuthor('Herbert, Frank')).toBe('frank herbert');
    expect(normalizeAuthor('Frank Herbert')).toBe('frank herbert');
  });

  it('splits initials so J.R.R. and J R R agree', () => {
    expect(normalizeAuthor('J.R.R. Tolkien')).toBe('j r r tolkien');
  });

  it('drops credential suffixes', () => {
    expect(normalizeAuthor('Jane Smith, PhD')).toBe('jane smith');
  });

  it('extracts surname regardless of given-name form', () => {
    expect(authorSurname('J.R.R. Tolkien')).toBe('tolkien');
    expect(authorSurname('Tolkien, John Ronald Reuel')).toBe('tolkien');
  });
});

describe('toIsbn13', () => {
  it('accepts a valid ISBN-13 and ignores hyphens', () => {
    expect(toIsbn13('978-0-441-01359-3')).toBe('9780441013593');
  });

  it('converts a valid ISBN-10, including the X check digit', () => {
    expect(toIsbn13('0441013597')).toBe('9780441013593');
    expect(toIsbn13('080442957X')).toBe('9780804429573');
  });

  it('rejects bad check digits rather than passing them through', () => {
    // The failure mode that matters: a corrupt ISBN silently returns no
    // holdings, which is indistinguishable from "library doesn't own it".
    expect(toIsbn13('9780441013594')).toBeUndefined();
    expect(toIsbn13('0441013598')).toBeUndefined();
  });

  it('rejects empty and malformed input', () => {
    expect(toIsbn13('')).toBeUndefined();
    expect(toIsbn13(undefined)).toBeUndefined();
    expect(toIsbn13('not-an-isbn')).toBeUndefined();
    expect(toIsbn13('12345')).toBeUndefined();
  });
});

describe('localWorkId', () => {
  it('collapses shelf variants of one book onto a single key', () => {
    expect(localWorkId('Dune (Dune, #1)', 'Frank Herbert')).toBe(
      localWorkId('Dune', 'Herbert, Frank'),
    );
  });

  it('keeps different books apart', () => {
    expect(localWorkId('Dune', 'Frank Herbert')).not.toBe(
      localWorkId('Dune Messiah', 'Frank Herbert'),
    );
  });

  it('is namespaced so it cannot be mistaken for an Open Library key', () => {
    expect(localWorkId('Dune', 'Frank Herbert')).toMatch(/^local:/);
  });
});
