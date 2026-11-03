import type { EnrichmentAdapter, SitePage } from '../../contracts/adapter';
import { cantDo } from '../errors';
import { failIfAsked } from '../mock-failure';
import { nameFromDomain } from '../sample';
import { textOf, titleOf } from './html';

// Sample website reading (Ruling 3): the same two made-up pages for any domain, with a meta description and the
// WordPress and HubSpot fingerprints, so the rules reading finds something.

const PROVIDER = 'Company website';

function page(url: string, html: string): SitePage {
  return { url, title: titleOf(html), text: textOf(html), html };
}

export function websiteMock(): EnrichmentAdapter {
  return {
    async test() {
      return { ok: true, message: 'Sample website reading is working.' };
    },

    async readSite({ domain }) {
      failIfAsked(PROVIDER);
      const name = nameFromDomain(domain);
      const home = `<html><head><title>${name} | Operations services for growing companies</title>
<meta name="description" content="${name} runs back-office operations for mid-sized companies across the Southeast.">
<link rel="stylesheet" href="/wp-content/themes/${domain.split('.')[0]}/style.css"></head>
<body><nav><a href="/about">About</a> <a href="/services">Services</a></nav>
<h1>Operations that scale with you</h1><p>${name} has served more than 300 clients since 2004 from offices in Charlotte and Atlanta.</p>
<script src="//js.hs-scripts.com/1234567.js"></script></body></html>`;
      const about = `<html><head><title>About ${name}</title></head>
<body><h1>About us</h1><p>Founded in 2004, ${name} has about 450 employees and serves clients in healthcare, logistics and real estate.</p></body></html>`;
      return { pages: [page(`https://${domain}/`, home), page(`https://${domain}/about`, about)] };
    },

    async companyEnrich() {
      throw cantDo(PROVIDER);
    },
    async peopleSearch() {
      throw cantDo(PROVIDER);
    },
    async revealEmail() {
      throw cantDo(PROVIDER);
    },
    async jobPostings() {
      throw cantDo(PROVIDER);
    },
    async news() {
      throw cantDo(PROVIDER);
    },
  };
}
