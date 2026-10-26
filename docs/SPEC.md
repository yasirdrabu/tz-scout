# Spec: Client Acquisition System

## Goal

Take a company from "who should we sell to" to "what did a won client cost" in one place. Run it on Taazaa's pipeline for 90 days, then offer it to mid-market clients.

## Users

| Role | Can do |
|---|---|
| Owner | Everything for their company; approves segments and budgets |
| Operator | Runs tests, campaigns, weekly fixes |
| Sales (SDR / AE) | Sees validated leads and meetings, logs outcomes |
| Admin (Taazaa) | Manages companies, users, integrations, AI settings |

## Navigation

Left nav per company: Offerings, Segments, Message tests, Funnel model, Leads, Meetings, Scorecard, Settings. A company switcher at the top for admins.

---

## Module 1: Offer intake

Records per offering: name, one-line promise, price range, gross margin, typical deal size, sales cycle (days), target titles, company size range, revenue band, industries, regions, exclusions (domains and categories), linked case studies, proof points.

AI assist: paste a URL or upload a deck or case study; Claude drafts the fields; user edits and approves. Draft and approved states.

Acceptance:
- Create, edit, archive an offering.
- AI draft fills at least promise, target buyer and proof points from a URL or file; user must approve before it's used elsewhere.
- Case studies are their own records (title, client, industry, result, link) and can attach to many offerings.

## Module 2: Segment scoring

Claude proposes 8 to 12 segments per offering. A segment = a buyer + a problem (e.g. "Operations leaders at 200 to 1,000 person logistics firms running dispatch on spreadsheets").

Enrichment per segment (via adapters, mocked first): LinkedIn audience size, Google monthly search volume, average cost per click, count of matching case studies.

Score out of 100, two halves. Each factor 0 to 10, weighted:

| Half | Factor | Weight | Source |
|---|---|---|---|
| Market (50) | Pain severity | 12 | AI, editable |
| | Urgency or trigger events | 10 | AI, editable |
| | Reachable audience size | 10 | Data (LinkedIn size) |
| | Ability to pay | 10 | AI + revenue band |
| | Competition for attention | 8 | Data (cost per click), inverted |
| Fit (50) | Proof we have | 14 | Data (case study matches) |
| | Delivery fit | 12 | AI, editable |
| | Deal size vs target | 10 | Offering data |
| | Buying committee complexity | 7 | AI, inverted |
| | Sales cycle length | 7 | AI, inverted |

Score = sum(factor/10 × weight). Weights editable per company in Settings.

Each factor shows a one-line reason. Users can override any AI factor (override is stored and marked).

Views: ranked list with score, half scores, audience size, cost per click, case study count; detail page with a factor breakdown bar chart and reasons. Status: proposed, shortlisted, active, rejected. Users can add a segment by hand and score it.

Acceptance:
- Generate segments for an approved offering; each has all factors, reasons and a total.
- Changing a weight re-ranks the list instantly.
- Overrides survive regeneration.
- Up to 3 segments can be active per offering at a time (configurable).

## Module 3: Message tests

For an active segment, Claude writes 12 to 15 statements: half problems the buyer has, half outcomes they want. Written in the buyer's words, under 25 words each, no product names.

A batch = a set of statements launched together. Each statement runs as its own ad set (Meta first; LinkedIn optional). Batch settings: budget (default $300), duration (default 72 hours), channel, targets for clickthrough rate and cost per click.

Results per statement: impressions, clicks, clickthrough rate, cost per click, spend. Pass = clickthrough rate at or above target AND cost per click at or below target. Show pass/fail chips. Minimum 1,000 impressions before a verdict, otherwise "not enough data".

Actions: keep, drop, rewrite (Claude suggests a rewrite based on winners), retest. Winners are saved to a statement library per segment and can be exported as ad copy, landing page headlines and discovery call questions.

Acceptance:
- Generate, edit, approve a batch; launch via adapter (mock returns realistic random results after a simulated delay).
- Verdict logic matches the rule above, unit tested.
- Library shows all winners per segment across batches.

## Module 4: Funnel model

Eight stages, one rate each:

| # | Stage | Rate | Default source |
|---|---|---|---|
| 1 | Impressions | Cost per 1,000 impressions ($) | Ad history or company default |
| 2 | Clicks | Clickthrough rate | Ad history |
| 3 | Form fills | Form conversion rate | Site history |
| 4 | Validated leads | Validation pass rate | Module 5 history |
| 5 | Discovery calls held | Show-up rate | HubSpot meetings |
| 6 | Sales-qualified | Qualification rate | HubSpot stages |
| 7 | Sales calls held | Show-up rate | HubSpot meetings |
| 8 | Won | Close rate | HubSpot deals |

Math (in `src/lib/funnel.ts`):
- cost per click = CPM / 1000 / CTR
- cost at stage n = cost at stage n-1 / rate n (for stages 3 to 8)
- cost per won client = cost at stage 8
- profit per client = deal value × margin - cost per won client
- return = (deal value × margin) / cost per won client
- with expansion: add expansion rate × expansion value × expansion margin to profit and return
- budget needed = target won clients per month × cost per won client
- clients from budget = budget / cost per won client

UI: a row per stage with a slider and number input, default shown beside it, and the resulting cost per stage. Summary panel: cost per won client, profit per client, return, budget needed for a target. Scenario save and compare (side by side, up to 3). A "presentation mode" with large type for use in client meetings.

Acceptance:
- Math unit tested against hand-calculated cases.
- Defaults pull from HubSpot adapter history when present, else company defaults.
- Scenarios saved per offering.

## Module 5: Lead validation agent

Trigger: new form submission (webhook or HubSpot form event).

Checks, each pass/fail/unknown with a reason:
1. Work email (not a free provider, domain resolves)
2. Company size in target range
3. Revenue band in target range
4. Industry in target list and not excluded
5. Role and seniority match target titles
6. Timeline from form answer within target window
7. Not an existing customer or open deal (HubSpot lookup)

Data from the company data adapter + Claude reading the company website. Claude writes a 3 to 5 line research note.

All pass = validated. Any fail = not qualified, routed to nurture with the reason. Any unknown = review queue for a human.

Writes to HubSpot: lead status, research note, check results (custom properties), owner assignment by round robin.

Acceptance:
- Runs as a background job within 2 minutes of submission.
- Every decision is explainable from the stored checks.
- Human can override, and the override is logged.

## Module 6: Show-up agent

After validation: send booking link. On booking: confirmation + reminders at 24 hours and 1 hour (email; SMS where consented). Pre-call note with one relevant case study (matched by industry). No-show: rebook sequence (3 touches over 7 days). All outcomes logged as meeting records and to HubSpot.

Acceptance:
- Sequence timing configurable per company.
- Meeting status: booked, held, no-show, rebooked, cancelled.
- Show-up rates by week feed Module 4 and Module 7.

## Module 7: Weekly scorecard

Rows grouped Marketing / Sales: spend, impressions, cost per 1,000, clicks, clickthrough, cost per click, form fills, form conversion, cost per form fill, validated leads, validation rate, cost per validated lead, discovery calls held, show-up rate, cost per discovery call, sales-qualified, qualification rate, cost per qualified, sales calls held, show-up rate, cost per sales call, won, close rate, cost per won client, revenue closed.

Columns: target, each week (Mon to Sun), rolling 4-week average.

Colour: green at or better than target, amber within 15% worse, red beyond. Grey when sample is below a minimum (configurable per row).

AI diagnosis (Monday job): Claude reads the last 4 weeks, names the single biggest bottleneck, the likely cause and 1 to 3 fixes, each with an owner role. Shown as two rows above the table and as a weekly summary card. Fix checklist carries over until done.

Feedback: closed-won deals are sent to ad platforms as offline conversions (adapter).

Acceptance:
- Builds from adapters for the selected week range.
- Colour logic unit tested.
- Diagnosis stored per week, editable, with the fixes as tasks.

---

## Data model (Prisma)

Company, User (role per company), Offering, CaseStudy, OfferingCaseStudy, Segment, SegmentFactor, Batch, Statement, StatementResult, FunnelScenario, Lead, LeadCheck, Meeting, DealLink (HubSpot id + cached stage/value), Week, WeekMetric, Diagnosis, Fix, AiRun, IntegrationConnection, Settings.

## Integrations (adapter + mock each)

hubspot, meta, linkedin, googleAds, companyData, booking, messaging (email/SMS), anthropic.

## Out of scope for Phase 1

Billing, client self-signup, white-labeling, creative/video generation, landing page builder.
