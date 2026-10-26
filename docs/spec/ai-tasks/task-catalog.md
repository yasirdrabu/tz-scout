# AI-E3 Task catalog

Each task is one file in `src/modules/ai-tasks/tasks/` with its prompt in `prompts/`. The owning
module decides when it runs and stores the result; AI runs it. Input and output below are summaries;
the Zod schemas in code are the contract.

## Carried from today (`src/ai/*`)

| Task | Owner module | Input | Output | Rules fallback | Release |
|---|---|---|---|---|---|
| `account_brief` (was accountBrief) | PLB | account facts, signals, best offer, people | why now, angle, opener, who to contact first | yes | R1 |
| `call_prep` | PLB | account, offer, plan, past calls | discovery plan and questions | yes | R2 |
| `call_review` | PLB | transcript or recap, checklist | 7-item score, pains in their words, next steps, coaching, follow-up email | no | R2 |
| `offer_draft` (was offeringDraft) | OFF | URL text or file text | offer fields draft | no | R2 |
| `offer_readiness` | OFF | offer, proof, wins | judged factor scores and fixes | yes | R2 |
| `outreach_sequence` | PLB | account, offer, primary person, owner | 4 emails (day 0, 3, 7, 14) | yes | R2 |
| `proposal` | PLB | account, offer, reviewed calls | proposal draft | no | R3 |
| `segments` | OFF | approved offer | 8 to 12 segments with factor scores and reasons | yes (mock library) | R4 |
| `statements` | CMP | segment | 12 to 15 buyer statements | yes | R4 |
| `weekly_diagnosis` | ANL | last 4 weeks of scorecard | biggest bottleneck, cause, 1 to 3 fixes with owner role | yes | R3 |
| `win_analysis` | OFF | closed-won deals | patterns, offer mapping, suggested signal rules | no | R3 |

Rules that carry over: openers and emails never quote research intent data, lawsuits or breaches to
the buyer; proposals never quote internal research (CHANGELOG 2026-10-15).

## New

| Task | Owner module | Input | Output | Rules fallback | Release |
|---|---|---|---|---|---|
| `csv_column_mapping` | SRC | header row, up to 20 sample rows, target field list | per column: target field or ignore, confidence 0 to 1, reason | yes (header name matching, already in `src/lib/leadSheet.ts` and `research.ts`) | R1 |
| `brief_sections` | PLB | account, facts, signals, committee, playbook template's section list | overview, what they do, potential size, why now, possible approach, value angle, risks; each 2 to 6 sentences with the fact ids it used. The overview also serves as the 3 to 5 line research note v1's lead validation wrote; v1's `lead_research` task is dropped (spec's call, D31) | partial (why now and committee from data) | R2 |
| `retro_summary` | PLB | account timeline, outcomes, steps, notes | what worked, what didn't, key learnings, proposed template edits (as structured diffs) | no | R2 |
| `conflict_explanation` | ACC | two conflicting facts with sources and dates | one-line explanation of the likely reason and which looks more current | yes (newer and higher-trust first) | R2 |
| `committee_gaps` | PLB | people with roles, offer's usual buyers | missing roles and suggested titles to look for | yes | R2 |
| `read_website` | ENR | fetched pages of the company's site (text, with URLs) | description, offering, industry guess, size clues, technologies; each citing the page URL | no (marked "not read" without a key) | R2 |
| `arrival_normalise` | SRC | free-text arrival notes from an agent | structured facts and signals with dates and source links | no | R1 |

## Output rules for every task

- Plain words, no em dashes, no acronyms the UI rules forbid.
- Every claim about an account cites the fact or signal ids it came from, so the UI can link "why".
- Money in integer cents, rates as decimals.
