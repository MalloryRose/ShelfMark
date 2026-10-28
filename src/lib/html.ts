/**
 * Just enough HTML handling for catalogs that only speak markup.
 *
 * There is no `DOMParser` in a service worker. These helpers serve adapters that
 * pull a handful of labelled values out of a known template; if an adapter ever
 * needs to walk real markup, bundle `htmlparser2` instead of growing this file.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Visible text of a fragment: tags dropped, entities decoded, whitespace collapsed. */
export function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}
