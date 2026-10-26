> Superseded by `docs/spec/` (Taazaa Scout spec v2). Kept as history.

# Build plan

One milestone per Claude Code session. Start each with: "Read CLAUDE.md and docs/SPEC.md, then do milestone N from docs/BUILD_PLAN.md. Plan first, then build."

| # | Milestone | Done when |
|---|---|---|
| 0 | Scaffold | App runs, sign-in works, company switcher, nav, Prisma schema for all models, seed script with Taazaa + 3 offerings + 6 case studies, all adapters stubbed with mocks, CI (typecheck, lint, test) |
| 1 | Offer intake | Module 1 acceptance criteria met |
| 2 | Funnel model | `funnel.ts` with tests, Module 4 UI, scenarios, presentation mode |
| 3 | Segment scoring | Module 2: generation, enrichment from mocks, weighted scoring, overrides, breakdown chart |
| 4 | Message tests | Module 3: batches, mock launch and results, verdict logic, library, export |
| 5 | Lead validation | Module 5: job, checks, research note, review queue, HubSpot write (mock) |
| 6 | Show-up agent | Module 6: sequences, meeting statuses, mock sends |
| 7 | Weekly scorecard | Module 7: metrics build, colours, rolling average, AI diagnosis, fixes |
| 8 | Live HubSpot | Live HubSpot adapter: read deals/meetings for funnel defaults, write lead status and notes |
| 9 | Live Meta | Live Meta adapter: launch test ad sets, pull results, send conversions |
| 10 | Live LinkedIn + Google | When API access is approved |
| 11 | Hardening | Roles and permissions audit, company isolation tests, error states, logging, deploy |

Milestones 0 to 7 need no external API access. 8 onward wait on credentials.

## Phase 0 (runs in parallel, no code)

While milestones 0 to 3 are built, run one round by hand: score 6 to 8 segments for one offering in a spreadsheet, write 12 statements for the top 2, run them as small Meta ad sets, record results. These numbers become the first real seed data and targets.
