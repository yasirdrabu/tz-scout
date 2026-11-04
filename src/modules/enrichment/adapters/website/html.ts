// Small HTML readers for website pages: the title, the visible text, the links and a page's tags of one name.
// Each reads at most the first 256 KB of a page, scanning forward with `indexOf` (review C1): no regex here runs over
// the page itself, so a hostile or broken page (unclosed tags, a binary blob) costs linear time, not a frozen worker.

/** Characters of a page any reader looks at. */
export const HTML_MAX = 256 * 1024;
/** Longest tag whose attributes are read. */
const TAG_MAX = 4000;
/** Characters of a link's inner HTML read for its text. */
const LINK_TEXT_MAX = 1000;
/** Blocks whose content is never visible text. */
const HIDDEN = ['head', 'script', 'style', 'noscript', 'template', 'svg', 'title'];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
/** The part of a page the readers look at. */
export const capHtml = (html: string) => (html.length > HTML_MAX ? html.slice(0, HTML_MAX) : html);
/** ASCII-lowercased, so its indexes match the original's. */
const lower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
const isWordChar = (c: string | undefined) => c !== undefined && /\w/.test(c);

/** Where a `<name` tag starts at or after `from` (a whole tag name, as `<name\b`), else -1. `lc` is lowercased. */
function openAt(lc: string, name: string, from: number): number {
  const needle = `<${name}`;
  for (let i = lc.indexOf(needle, from); i >= 0; i = lc.indexOf(needle, i + 1)) {
    if (!isWordChar(lc[i + needle.length])) return i;
  }
  return -1;
}

/** `indexOf(needle, pos)` that remembers its last answer, so many openers with no closer stay linear. */
function finder(lc: string, needle: string): (pos: number) => number {
  let from = Infinity;
  let at = -1;
  return (pos) => {
    // The last search from `from` found the first `needle` at `at` (-1: none), so it answers every `pos` up to `at`.
    if (pos >= from && (at === -1 || at >= pos)) return at;
    from = pos;
    at = lc.indexOf(needle, pos);
    return at;
  };
}

export function titleOf(html: string): string {
  const h = capHtml(html);
  const lc = lower(h);
  const at = openAt(lc, 'title', 0);
  const gt = at < 0 ? -1 : lc.indexOf('>', at);
  const end = gt < 0 ? -1 : lc.indexOf('</title>', gt);
  return end < 0 ? '' : squash(decodeEntities(h.slice(gt + 1, end)));
}

/** The visible text: scripts, styles and the head removed, tags dropped, entities decoded, spaces collapsed. */
export function textOf(html: string): string {
  const h = capHtml(html);
  const lc = lower(h);
  const closers = new Map(HIDDEN.map((n) => [n, finder(lc, `</${n}>`)]));
  const commentEnd = finder(lc, '-->');
  const out: string[] = [];
  let p = 0;
  while (p < h.length) {
    const lt = h.indexOf('<', p);
    if (lt < 0) {
      out.push(h.slice(p));
      break;
    }
    out.push(h.slice(p, lt), ' ');
    // A comment or a hidden block goes up to its end; one never closed is dropped as a tag.
    if (lc.startsWith('<!--', lt)) {
      const e = commentEnd(lt + 4);
      if (e >= 0) {
        p = e + 3;
        continue;
      }
    }
    const hidden = HIDDEN.find((n) => lc.startsWith(`<${n}`, lt) && !isWordChar(lc[lt + 1 + n.length]));
    if (hidden) {
      const e = closers.get(hidden)!(lt);
      if (e >= 0) {
        p = e + hidden.length + 3;
        continue;
      }
    }
    const gt = h.indexOf('>', lt + 1);
    if (gt < 0) {
      out.push(h.slice(lt));
      break;
    }
    p = gt + 1;
  }
  return squash(decodeEntities(out.join('')));
}

/** A quoted attribute of a tag. */
export function attrOf(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[1] ?? m[2]) : undefined;
}

/** Every `<name …>` tag of the page, as written, skipping any longer than 4,000 characters. */
export function tagsOf(html: string, name: string): string[] {
  const h = capHtml(html);
  const lc = lower(h);
  const out: string[] = [];
  let gt = -1;
  for (let i = openAt(lc, name, 0); i >= 0; i = openAt(lc, name, i + 1)) {
    if (gt < i) gt = lc.indexOf('>', i);
    if (gt < 0) break;
    if (gt - i < TAG_MAX) out.push(h.slice(i, gt + 1));
  }
  return out;
}

/**
 * Every `<a href>` with its link text: up to its `</a>`, or for an anchor never closed up to the next `<a` (at most
 * 1,000 characters either way). The scan only moves forward, so it stays linear.
 */
export function linksOf(html: string): { href: string; text: string }[] {
  const h = capHtml(html);
  const lc = lower(h);
  const closeAt = finder(lc, '</a>');
  const out: { href: string; text: string }[] = [];
  let i = openAt(lc, 'a', 0);
  while (i >= 0) {
    const gt = lc.indexOf('>', i);
    if (gt < 0) break;
    const start = gt + 1;
    const next = openAt(lc, 'a', start);
    const close = closeAt(start);
    const closed = close >= 0 && (next < 0 || close < next);
    const end = Math.min(closed ? close : next < 0 ? h.length : next, start + LINK_TEXT_MAX);
    const href = gt - i < TAG_MAX ? attrOf(h.slice(i, gt + 1), 'href') : undefined;
    if (href !== undefined) out.push({ href: decodeEntities(href.trim()), text: textOf(h.slice(start, end)) });
    i = next;
  }
  return out;
}
