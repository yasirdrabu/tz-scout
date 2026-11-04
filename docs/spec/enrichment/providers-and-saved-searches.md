# ENR-E2 Providers and saved searches

Status: Providers shipped in R2b-2 (ENR-E2-S1); saved searches not yet · Release: R1

R2b-2 shipped plan docs/plans/2026-11-03-r2b-2-enrichment.md. Its rulings for providers are below
("R2b-2 rulings"); where they differ from the Rules, the rulings win.

## Why

Today Apollo is the main way to find new companies and the people at them, Vibe runs through Claude
outside Scout, and the company website is a free source Claude can read. In Scout, Apollo and Vibe are
both called directly (D34). Each sits behind an adapter with mock and live versions. Saved searches (today's "Pulls") run on a schedule and feed intake.

## Rules

### Providers

| Provider key | Operations | Credentials | Notes |
|---|---|---|---|
| `apollo` | company search, company enrich, people search, email reveal, job postings, news | API key per tenant (INT) | Today's `apollo.ts` behaviour; emails only revealed on request |
| `vibe` | company search, company enrich, people search, email reveal, business events (signals) | API key per tenant (INT) | Called directly like Apollo (D34). v1 reached Vibe only through the Vibe connector in Claude plus `scripts/import-vibe.mts`; the live adapter calls Vibe's (Explorium's) API instead and keeps v1's pure mapping from `src/integrations/prospects/vibe.ts` (company shape, NAICS to industry, range midpoints, intent topic labels, events to signals, exclusions) and `vibeExport.ts` (people, seniority). Exact endpoints confirmed when the adapter is built. Vibe exports still import through SRC file import with the Vibe layout, with `reported_cost` on the batch |
| `website` | website read | none (uses the AI connection) | Fetches the home page and up to 4 linked pages (about, services, industries, contact); 30-second limit; respects robots.txt |
| `mock` | all | none | Seeded sample companies and people |

- Each provider adapter implements: `estimate(operation, params)`, `run(operation, params)` returning
  results as `arrival.v1` items plus `creditsUsed`, and `health()`.
- A new provider is added in code (non-goal: no-code providers).
- Every provider is registered in SRC as a `vendor` source so its data carries provenance and trust.

### Saved searches

- Fields carried from today's pulls: name, provider, offer and practice it's for, filters (industries,
  employee range, revenue range, locations, keywords, hiring titles, technologies, buyer titles,
  exclude domains), max companies per run (default 25), schedule (`off`, `daily`, `weekly` on Monday),
  max credits per run (default 200, today's `APOLLO_MAX_CREDITS_PER_RUN`).
- Creating a saved search registers a `scheduled_pull` source under the provider's vendor source.
- A person with `searches:manage` creates and schedules searches; creating one is the approval for its
  runs within the per-run credit cap (no per-run approval).
- Each run creates an SRC batch (`criteria` = the filters) and submits each company, with people found
  for the buyer titles, as an arrival. Already-known companies attach and never return to the queue
  (SRC-E3-S4).
- The run shows its estimate before "Run now" and on the schedule page.

## R2b-2 rulings

Rulings 2 and 3 are the user's answers of 2026-11-03; the build rulings are Claude's calls,
2026-11-03.

- **Ruling 2 (user). Vibe is sample data only.** The Vibe adapter registers only a mock side, built on
  v1's pure mapping (`vibe.ts`, `vibeExport.ts`) carried into `adapters/vibe/mapping.ts` with its v1
  tests, and it answers the same operations and credits as Apollo. Setting Vibe live keeps INT's 409
  "This service can't run live yet." A live adapter is a follow-up, once there is a key and confirmed
  endpoints. This differs from the providers table above, which calls Vibe directly.
- **Ruling 3 (user). Website read is in.**
  - **Provider:** `website` in INT's list (`name: 'Company website'`, `usedFor: 'Reads company
    websites'`, interface owner `enrichment`, release R2, `needsCredential: false`). It goes live with
    no credential, and its Test connection answers "Ready to read company websites. No key is needed."
  - **Live adapter:** fetches the home page and up to 4 same-host linked pages whose path or link text
    matches `about|services|industries|contact`, with user agent `TaazaaScout/1.0
    (+https://scout.taazaa.ai/bot)`, in at most 30 seconds in all and 2 MB per page.
  - **Mock adapter:** two fixed sample pages for any domain.
  - **Reading:** the pages go to AI task `read_website` (prompt v1.1), whose output is `{description,
    industry_guess, technologies[], facts:[{key, value, url}]}`, every item citing a page URL. Size
    clues are not asked for, since nothing stored them (final review M1). Its `rules` take the title
    and meta description, technologies from a fixed fingerprint list in the HTML, and no industry
    guess. With Claude on mock, or at its limit, the rules output is used and the request's result says
    "Read by rules". A website read uses 0 credits; its Claude cost goes through `anthropic`.
  - **Website facts (final review I3).** A website read writes only the description, the industry,
    the technologies, and these `facts` keys: `founded_year` (a 4-digit year), `employees` (a whole
    number), `hq_city`, `hq_state`, `hq_country` (as the ISO code intake stores, so "United States" is
    "US") and `keywords` (split on commas). Any other key, or a value its column can't take, is dropped,
    so page text can't set the account's domain, name, parent, or scoring and research facts. The
    prompt asks for these keys only.
- **Website safety (build ruling).** The domain comes from account data, so the reader reaches only
  public sites:
  - Host names are checked before a request, and every address a name resolves to is checked when the
    connection is made (DNS checked at connect, so rebinding has no window). Private, loopback,
    link-local, CGNAT, documentation, benchmarking and multicast ranges are blocked, as are the 6to4
    relay 192.88.99.0/24 and the IPv6 forms that carry an IPv4 address (NAT64, 6to4 `2002::/16`,
    Teredo `2001:0::/32`).
  - **HTML reading (final review C1).** The title, text, links and meta tags are read from the first
    256 KB of a page only, in one forward scan with no backtracking regex (an anchor never closed keeps
    its link, with its text up to the next `<a`), so a hostile or broken page
    (unclosed tags, a binary blob with no content type) costs linear time and cannot freeze a worker.
  - Redirects are followed by hand, at most 3 hops, each hop checked; linked pages stay on the
    company's host.
  - `robots.txt` is read as RFC 9309 reads it: the `User-agent: *` group and any group naming Scout,
    merged; `Allow` and `Disallow` with `*` and a trailing `$`; the longest match decides, Allow wins a
    tie. A 4xx means no rules; a 5xx means read nothing (disallow all). A disallowed page is skipped
    and the home page is still read when allowed.
  - A home page that can't be reached, or answers 4xx, fails as `bad_request` "Scout couldn't reach
    {domain}." A home-page 5xx, a dropped connection or a DNS hiccup retries (`unknown`); a 429 is
    `rate_limited`. When the 30 seconds run out before the home page is read, the read fails as
    `timeout`; after that it keeps the pages it has. A linked page that fails is skipped.
  - The website provider does no connection health bookkeeping: a failed read is that company's site,
    not Scout's connection, so it never marks the connection failing or connected.
- **Apollo live** ports v1's `apollo.ts`: the key from INT as `x-api-key`, every response zod-parsed,
  401 is `auth`, 403 is `bad_request` with v1's master-key message, 429 is `rate_limited`, "insufficient
  credits" is `out_of_credits`. Test connection calls `organizations/enrich?domain=apollo.io`. People
  search uses `q_organization_domains_list[]` and keeps only the first name and title the free search
  gives; the reveal fills in the rest.
- **Apollo mock** ports v1's `mock.ts`: deterministic per domain, reporting credits as Apollo would, and
  tests can make it fail with `setMockFailure(kind | null)`.

## Stories

### ENR-E2-S1 Provider adapters
As a developer, I want every provider behind the same interface with mock and live versions, so that
Scout runs end to end without keys.
- ENR-E2-S1-AC1 Apollo adapter tests against stubbed Apollo responses (today's `apollo.test.ts`
  fixtures) pass through the new interface.
- ENR-E2-S1-AC4 The Vibe adapter, tested against stubbed Vibe responses, returns companies, people and
  business events as `arrival.v1` items with `creditsUsed`, and a saved search can pick `vibe` as its
  provider. v1's `vibe.test.ts` and `vibeExport.test.ts` cases pass through the carried-over mapping.
- ENR-E2-S1-AC2 The website reader returns description, industry guess and technologies as facts with
  the page URL (size clues dropped in R2b-2, final review M1); with the Claude connection mode = mock it returns rule-based extraction labelled
  "Read by rules".
- ENR-E2-S1-AC3 `health()` results show on the integration's page in INT.

### ENR-E2-S2 Saved searches
As an operator, I want to save a search and run it on a schedule, so that new matching companies keep
arriving.
- ENR-E2-S2-AC1 Searches page lists saved searches with provider, offer, schedule, last run (found,
  new, credits) and next run; "Run now" shows the estimate first.
- ENR-E2-S2-AC2 A scheduled run publishes `jobs.enrichment.search.run`; the run's companies appear as a
  batch from the search's `scheduled_pull` source.
- ENR-E2-S2-AC3 A run never spends more than its credit cap; when it stops at the cap it is `partial`
  and says so.
