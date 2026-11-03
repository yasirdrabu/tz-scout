// Small HTML readers for website pages: the title, the visible text and the links. Regex-based on purpose: pages
// are capped at 2 MB, and the text only feeds a bounded prompt.

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

export const titleOf = (html: string): string => squash(decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''));

/** The visible text: scripts, styles and the head removed, tags dropped, entities decoded, spaces collapsed. */
export function textOf(html: string): string {
  const body = html
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<title\b[\s\S]*?<\/title>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return squash(decodeEntities(body));
}

/** Every `<a href>` with its link text. */
export function linksOf(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: decodeEntities(m[2]!.trim()), text: squash(decodeEntities(m[3]!.replace(/<[^>]+>/g, ' '))) });
  }
  return out;
}
