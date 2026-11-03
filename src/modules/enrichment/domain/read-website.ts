import { z } from 'zod';
import type { SitePage } from '../contracts/adapter';
import { decodeEntities } from '../adapters/website/html';

// The `read_website` task's input and output, and its rules (Ruling 3). The HTML is read here, before the task:
// the meta description and the technologies from a fixed fingerprint list go in as fields, so the prompt carries
// no markup and the rules stay pure.

/** Characters of text kept per page, so the prompt stays bounded. */
export const PAGE_TEXT_MAX = 6000;
const MAX_PAGES = 5;

const url = z.string().min(1).max(2000);

export const readWebsiteInputSchema = z.object({
  domain: z.string().min(1).max(255),
  pages: z
    .array(
      z.object({
        url,
        title: z.string().max(300),
        text: z.string().max(PAGE_TEXT_MAX),
        description: z.string().max(500).nullable(),
        technologies: z.array(z.string()).max(30),
      }),
    )
    .max(MAX_PAGES),
});
export type ReadWebsiteInput = z.infer<typeof readWebsiteInputSchema>;

const cited = z.object({ text: z.string().min(1).max(600), url });

/** Every item cites the page it came from. */
export const readWebsiteOutputSchema = z.object({
  description: cited.nullable(),
  industry_guess: cited.nullable(),
  size_clues: z.array(cited).max(10),
  technologies: z.array(z.object({ name: z.string().min(1).max(80), url })).max(30),
  facts: z.array(z.object({ key: z.string().min(1).max(60), value: z.string().min(1).max(300), url })).max(30),
});
export type ReadWebsiteOutput = z.infer<typeof readWebsiteOutputSchema>;

/** Technologies a page's HTML gives away, in this order. */
const FINGERPRINTS: [string, RegExp][] = [
  ['WordPress', /\/wp-content\/|\/wp-includes\/|<meta[^>]+generator[^>]+wordpress/i],
  ['HubSpot', /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net|\/hs\/hsstatic\//i],
  ['Shopify', /cdn\.shopify\.com/i],
  ['Wix', /static\.wixstatic\.com|static\.parastorage\.com/i],
  ['Squarespace', /static1\.squarespace\.com|squarespace-cdn\.com/i],
  ['Webflow', /assets\.website-files\.com|data-wf-site=/i],
  ['Drupal', /\/sites\/default\/files\/|drupal-settings-json/i],
  ['Google Tag Manager', /googletagmanager\.com\/gtm\.js/i],
  ['Google Analytics', /google-analytics\.com\/|googletagmanager\.com\/gtag\/js/i],
  ['Salesforce Pardot', /pi\.pardot\.com|go\.pardot\.com/i],
  ['Marketo', /munchkin\.marketo\.net|mktoForms2/i],
  ['Intercom', /widget\.intercom\.io|js\.intercomcdn\.com/i],
  ['Zendesk', /static\.zdassets\.com/i],
  ['Next.js', /__NEXT_DATA__|\/_next\/static\//i],
];

export const fingerprints = (html: string): string[] => FINGERPRINTS.filter(([, re]) => re.test(html)).map(([name]) => name);

/** The page's `<meta name="description">`, else its `og:description`. */
export function metaDescription(html: string): string | null {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2];
  const find = (want: string) => {
    const tag = metas.find((m) => (attr(m, 'name') ?? attr(m, 'property'))?.toLowerCase() === want);
    const content = tag ? attr(tag, 'content') : undefined;
    return content ? decodeEntities(content).replace(/\s+/g, ' ').trim() || null : null;
  };
  return find('description') ?? find('og:description');
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** The task's input from the pages a website read returned (at most 5, text capped). */
export function readWebsiteInput(domain: string, pages: SitePage[]): ReadWebsiteInput {
  return {
    domain,
    pages: pages.slice(0, MAX_PAGES).map((p) => {
      const description = metaDescription(p.html);
      return {
        url: p.url,
        title: cut(p.title, 300),
        text: cut(p.text, PAGE_TEXT_MAX),
        description: description ? cut(description, 500) : null,
        technologies: fingerprints(p.html),
      };
    }),
  };
}

/** Without Claude: the meta description, the home page's title and the fingerprinted technologies. No industry guess. */
export function rulesRead(i: ReadWebsiteInput): ReadWebsiteOutput {
  const described = i.pages.find((p) => p.description);
  const home = i.pages[0];
  const technologies: ReadWebsiteOutput['technologies'] = [];
  for (const p of i.pages) {
    for (const name of p.technologies) if (!technologies.some((t) => t.name === name)) technologies.push({ name, url: p.url });
  }
  return {
    description: described?.description ? { text: cut(described.description, 600), url: described.url } : null,
    industry_guess: null,
    size_clues: [],
    technologies: technologies.slice(0, 30),
    facts: home?.title ? [{ key: 'website_title', value: home.title, url: home.url }] : [],
  };
}

/** The output with every item whose `url` is not one of the input pages dropped (Claude may cite a page it wasn't given). */
export function citedOnly(i: ReadWebsiteInput, o: ReadWebsiteOutput): ReadWebsiteOutput {
  const urls = new Set(i.pages.map((p) => p.url));
  const ok = <T extends { url: string }>(x: T) => urls.has(x.url);
  return {
    description: o.description && ok(o.description) ? o.description : null,
    industry_guess: o.industry_guess && ok(o.industry_guess) ? o.industry_guess : null,
    size_clues: o.size_clues.filter(ok),
    technologies: o.technologies.filter(ok),
    facts: o.facts.filter(ok),
  };
}
