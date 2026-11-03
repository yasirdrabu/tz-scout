import { z } from 'zod';
import type { SitePage } from '../contracts/adapter';
import { attrOf, capHtml, decodeEntities, tagsOf } from '../adapters/website/html';

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
  technologies: z.array(z.object({ name: z.string().min(1).max(80), url })).max(30),
  facts: z.array(z.object({ key: z.string().min(1).max(60), value: z.string().min(1).max(300), url })).max(30),
});
export type ReadWebsiteOutput = z.infer<typeof readWebsiteOutputSchema>;

const asText = (v: string) => v.trim() || undefined;
const asList = (v: string) => {
  const items = v.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
};
const asWhole = (v: string) => {
  const s = v.trim().replace(/,/g, '');
  return /^\d{1,7}$/.test(s) && Number(s) > 0 ? Number(s) : undefined;
};

/**
 * The only `facts` keys a website read may write (review I3), each as its account column takes it. Any other key,
 * or a value that isn't one (an employee count of "about 200"), is dropped: a page can't set the account's identity,
 * its parent, or its scoring or research facts. The prompt asks for these keys only.
 */
export const WEBSITE_FACT_KEYS: Record<string, (v: string) => unknown> = {
  founded_year: (v) => {
    const y = asWhole(v);
    return y !== undefined && y >= 1600 && y <= new Date().getUTCFullYear() ? y : undefined;
  },
  employees: asWhole,
  hq_city: asText,
  hq_state: asText,
  hq_country: asText,
  keywords: asList,
};

type WebsiteFact = { key: string; value: unknown; url: string };

/** The account facts a website read writes: the description, industry and technologies, and the allowed `facts`. */
export function websiteFacts(o: ReadWebsiteOutput): WebsiteFact[] {
  const out: WebsiteFact[] = [];
  if (o.description) out.push({ key: 'description', value: o.description.text, url: o.description.url });
  if (o.industry_guess) out.push({ key: 'industry', value: o.industry_guess.text, url: o.industry_guess.url });
  if (o.technologies.length) out.push({ key: 'technologies', value: o.technologies.map((x) => x.name), url: o.technologies[0]!.url });
  for (const x of o.facts) {
    const value = Object.hasOwn(WEBSITE_FACT_KEYS, x.key) ? WEBSITE_FACT_KEYS[x.key]!(x.value) : undefined;
    if (value !== undefined) out.push({ key: x.key, value, url: x.url });
  }
  return out;
}

/** Technologies a page's HTML gives away, in this order. Plain alternations only, so none can backtrack (review C1). */
const FINGERPRINTS: [string, RegExp][] = [
  ['WordPress', /\/wp-content\/|\/wp-includes\//i],
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

/** A `<meta name="generator">` naming WordPress gives it away too. */
const wordpressGenerator = (html: string) =>
  tagsOf(html, 'meta').some((t) => attrOf(t, 'name')?.toLowerCase() === 'generator' && /wordpress/i.test(attrOf(t, 'content') ?? ''));

/** The technologies of the page's first 256 KB. */
export function fingerprints(html: string): string[] {
  const h = capHtml(html);
  return FINGERPRINTS.filter(([name, re]) => re.test(h) || (name === 'WordPress' && wordpressGenerator(h))).map(([name]) => name);
}

/** The page's `<meta name="description">`, else its `og:description` (from its first 256 KB). */
export function metaDescription(html: string): string | null {
  const metas = tagsOf(html, 'meta');
  const attr = attrOf;
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
    technologies: o.technologies.filter(ok),
    facts: o.facts.filter(ok),
  };
}
