/**
 * Does a catalog record describe the book on the reader's shelf?
 *
 * Every provider gates its results through here, so a false "available now" —
 * the worst thing this product can tell someone — has one place to be fixed.
 * Phase 2 replaces the title rule with a similarity score; the call sites stay.
 */

import type { WorkIdentity } from '../core/types';
import { authorSurname, normalizeTitle, toIsbn13 } from './normalize';

/**
 * Title containment plus surname equality, both required.
 *
 * Containment catches "Dune" vs "Dune: 50th Anniversary" and "The Hobbit" vs
 * "The Hobbit, or There and Back Again" without accepting "Dune" for "Dune
 * Messiah" or "The Annotated Hobbit".
 */
export function titleAuthorAgree(work: WorkIdentity, title: string, author: string): boolean {
  const wanted = work.normalizedTitle;
  const got = normalizeTitle(title);
  if (!wanted || !got) return false;

  const titleAgrees = got === wanted || got.startsWith(`${wanted} `) || wanted.startsWith(`${got} `);
  if (!titleAgrees) return false;

  const wantedSurname = authorSurname(work.author);
  return wantedSurname.length > 0 && wantedSurname === authorSurname(author);
}

/**
 * An ISBN shared with the work's edition cluster is a match on its own — it is
 * the one signal that survives a catalog's idiosyncratic title transcription.
 */
export function sharesIsbn(work: WorkIdentity, isbns: readonly string[]): boolean {
  if (work.isbns.length === 0) return false;
  const cluster = new Set(work.isbns);
  return isbns.some((raw) => {
    const isbn = toIsbn13(raw);
    return isbn !== undefined && cluster.has(isbn);
  });
}

export function isMatch(
  work: WorkIdentity,
  record: { title: string; author: string; isbns?: readonly string[] },
): boolean {
  return sharesIsbn(work, record.isbns ?? []) || titleAuthorAgree(work, record.title, record.author);
}
