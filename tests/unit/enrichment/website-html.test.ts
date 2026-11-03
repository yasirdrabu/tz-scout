// The website HTML readers (review C1): they read the first 256 KB in linear time, so a hostile or broken page can't
// freeze a worker, and they still read ordinary pages as before.
import { describe, expect, it } from 'vitest';
import { HTML_MAX, linksOf, tagsOf, textOf, titleOf } from '@/modules/enrichment/adapters/website/html';
import { fingerprints, metaDescription } from '@/modules/enrichment/domain/read-website';

const MB2 = 2 * 1024 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(MB2 / unit.length)).slice(0, MB2);

const ADVERSARIAL: [string, string][] = [
  ['unclosed anchors', fill('<a href="x">')],
  ['unclosed anchors with text', fill('<a href="about">about us ')],
  ['nested unclosed tags', fill('<div><span><b><i>')],
  ['unclosed heads', fill('<head>')],
  ['unclosed scripts and styles', fill('<script><style><svg>')],
  ['unclosed titles', fill('<title>')],
  ['unclosed comments', fill('<!-- ')],
  ['metas naming the generator', fill('<meta name="generator" content="x ')],
  ['tags with no end', fill('<<a href="')],
  ['quotes that never close', fill(`<a href="'`)],
  ['entities with no semicolon', fill('&amp&#x41')],
];

describe('website HTML readers', () => {
  it.each(ADVERSARIAL)('read 2 MB of %s in well under a second', (_name, html) => {
    const started = performance.now();
    titleOf(html);
    textOf(html);
    linksOf(html);
    tagsOf(html, 'meta');
    metaDescription(html);
    fingerprints(html);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('look at the first 256 KB only', () => {
    const html = `${'x'.repeat(HTML_MAX)}<title>Late</title><a href="/about">About</a>`;
    expect(titleOf(html)).toBe('');
    expect(linksOf(html)).toEqual([]);
    expect(textOf(html)).toHaveLength(HTML_MAX);
  });

  it('read an ordinary page', () => {
    const html = `<!doctype html><HTML><Head><Title>Acme &amp; Co</Title><style>p{}</style></Head>
<body><!-- hidden --><header>Hi</header><script>var a = 1 < 2;</script>
<p>We move <b>freight</b>.</p><svg><title>icon</title></svg>
<A class="nav" HREF="/about">About <span>us</span></A> <a href='/contact'>Contact</a> <a name="x">No link</a>
<meta name="generator" content="WordPress 6.4"></body></HTML>`;
    expect(titleOf(html)).toBe('Acme & Co');
    expect(textOf(html)).toBe('Hi We move freight . About us Contact No link');
    expect(linksOf(html)).toEqual([
      { href: '/about', text: 'About us' },
      { href: '/contact', text: 'Contact' },
    ]);
    expect(fingerprints(html)).toEqual(['WordPress']);
  });
});
