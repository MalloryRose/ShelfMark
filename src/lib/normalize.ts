/**
 * Turning what a reader typed into something a catalog index will match.
 *
 * Goodreads titles carry series numbering, subtitles, edition notes and
 * translator credits that no library catalog stores the same way. Comparing raw
 * strings across the two is why the reference implementation accepts whatever
 * the search returns — this module is the first half of fixing that, and the
 * scorer in phase 2 is the second.
 *
 * Everything here is pure, so it is cheap to test and safe in a service worker.
 */

/** `Dune (Dune, #1)` and `Dune (Dune Chronicles #1)` → `Dune` */
const SERIES_SUFFIX = /\s*[([][^)\]]*#\s*\d+(?:\.\d+)?[^)\]]*[)\]]\s*$/;

/** Trailing edition/format noise: `(Unabridged)`, `[Large Print]`. */
const EDITION_SUFFIX =
  /\s*[([](?:un)?abridged|large print|illustrated|annotated|deluxe|anniversary|reissue|box(?:ed)? set|graphic novel|audio(?:book)?[^)\]]*[)\]]\s*$/i;

const LEADING_ARTICLE = /^(?:the|a|an)\s+/i;

/** Author credit noise: `Frank Herbert, PhD`, `Herbert, Frank`. */
const AUTHOR_SUFFIX = /,\s*(?:phd|md|jr\.?|sr\.?|i{2,3}|iv)\.?$/i;

/**
 * MARC name-heading noise, as print catalogs display it verbatim:
 * `Tolkien, J. R. R. (John Ronald Reuel), 1892-1973, author.`
 */
const MARC_FULLER_FORM = /\([^)]*\)/g;
const MARC_DATES = /\b\d{4}-(?:\d{4})?/g;
const MARC_RELATOR = /,?\s*\b(?:author|editor|illustrator|translator|narrator|contributor)\b\.?/gi;

export function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/**
 * Comparison form of a title. Lossy by design — never show this to a user.
 *
 * Subtitles are dropped because catalogs are wildly inconsistent about them:
 * one holds "Educated: A Memoir", the next holds "Educated". Keeping the
 * subtitle loses real matches; dropping it costs us almost nothing, because the
 * author still has to agree before we accept a candidate.
 */
export function normalizeTitle(raw: string): string {
  let out = raw.trim();

  // Order matters: series numbering can sit outside an edition note.
  out = out.replace(SERIES_SUFFIX, '');
  out = out.replace(EDITION_SUFFIX, '');

  // Drop a subtitle, but only when something survives — "Nineteen Eighty-Four:
  // 1984" must not normalise to the empty string.
  const colon = out.indexOf(':');
  if (colon > 0) {
    const head = out.slice(0, colon).trim();
    if (head.length >= 4) out = head;
  }

  out = stripDiacritics(out).toLowerCase();
  out = out.replace(LEADING_ARTICLE, '');
  out = out.replace(/['’`]/g, '');        // o'brien → obrien
  out = out.replace(/&/g, ' and ');
  out = out.replace(/[^a-z0-9]+/g, ' ');
  return out.trim().replace(/\s+/g, ' ');
}

/** Comparison form of an author. Handles `Surname, Given` from catalog records. */
export function normalizeAuthor(raw: string): string {
  // Strip MARC noise first, or the dates and relator terms end up read as the
  // given name once the heading is un-inverted below.
  let out = raw
    .replace(MARC_FULLER_FORM, '')
    .replace(MARC_DATES, '')
    .replace(MARC_RELATOR, '')
    .replace(/\s*,(?:\s*,)+/g, ',')
    .replace(/[\s,]+$/, '')
    .trim()
    .replace(AUTHOR_SUFFIX, '');

  // Catalogs invert names; reading lists don't.
  const comma = out.indexOf(',');
  if (comma > 0) {
    out = `${out.slice(comma + 1).trim()} ${out.slice(0, comma).trim()}`;
  }

  out = stripDiacritics(out).toLowerCase();
  out = out.replace(/\./g, ' ');           // J.R.R. → j r r
  out = out.replace(/[^a-z0-9]+/g, ' ');
  return out.trim().replace(/\s+/g, ' ');
}

/**
 * Surname, for the cheap author check that gates every candidate match.
 * Given names vary far more than surnames ("J.R.R." / "John Ronald Reuel").
 */
export function authorSurname(raw: string): string {
  const parts = normalizeAuthor(raw).split(' ').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// ---------------------------------------------------------------------------
// ISBN
// ---------------------------------------------------------------------------

function isbn10CheckDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(body[i]);
  const check = (11 - (sum % 11)) % 11;
  return check === 10 ? 'X' : String(check);
}

function isbn13CheckDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

/**
 * Normalise any ISBN to ISBN-13, or return undefined if it isn't one.
 *
 * Worth the care: Goodreads emits ISBN-10 while most catalogs index ISBN-13,
 * and an unvalidated ISBN silently poisons a lookup with no error to catch.
 */
export function toIsbn13(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/[^0-9Xx]/g, '').toUpperCase();

  if (s.length === 13) {
    if (!/^\d{13}$/.test(s)) return undefined;
    return isbn13CheckDigit(s.slice(0, 12)) === s[12] ? s : undefined;
  }

  if (s.length === 10) {
    if (!/^\d{9}[\dX]$/.test(s)) return undefined;
    if (isbn10CheckDigit(s.slice(0, 9)) !== s[9]) return undefined;
    const body = `978${s.slice(0, 9)}`;
    return body + isbn13CheckDigit(body);
  }

  return undefined;
}

/**
 * Stable work key before the Open Library resolver exists (phase 2 replaces
 * this with a real `OL…W` key). Prefixed so the two can never be confused.
 */
export function localWorkId(title: string, author: string): string {
  return `local:${normalizeTitle(title)}|${authorSurname(author)}`;
}
