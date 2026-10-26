# SRC-E5 Warm intros

Status: Draft · Release: R1 (basic) and R2 (confirmation and rules UI)

Release split (spec's call, D24): **R1** ships declaring a warm intro with an arrival (API, MCP, CSV,
"Add account"), relationship mapping, relationship default points, the unconfirmed-counts-half rule,
strongest-intro-counts, and points as a scoring input (SRC-E5-S1-AC1, SRC-E5-S2-AC2, SRC-E5-S3).
**R2** ships the Confirm flow (SRC-E5-S1-AC2) and the Settings screen for relationship defaults and
per-introducer rules (SRC-E5-S2-AC1). In R1 defaults are seeded and editable only by a platform admin.
This model is canonical; Scoring reads its result and keeps no points of its own.

## Why

An introduction from someone the buyer trusts is worth more than any signal, and how much more depends
on who made it (D3). A warm intro adds a fixed number of points to the account's priority; it never
skips review.

## Rules

- An arrival may declare a warm intro (`WarmIntroInput`: `introducer_name`, `introducer_email`,
  `relationship` as free text, `note`). An introducer whose email matches a tenant user is linked to
  that user; otherwise the intro is from a named outside person.
- The free-text relationship is mapped to a relationship key: an exact key, then keyword rules
  ("customer" → `customer_referral`, "partner" → `partner_referral`, "board", "investor" →
  `board_or_investor`, "met at", "event", "conference" → `event_meeting`, "knows", "friend",
  "former colleague" → `employee_network`), then AI task `arrival_normalise`, else `other`. The text
  is kept and the key is shown, so a reviewer can correct it.
- **Relationship keys** (tenant-configurable list, defaults and default points):

  | Key | Label | Default points |
  |---|---|---|
  | `customer_referral` | Referred by a current customer | 15 |
  | `partner_referral` | Referred by a partner | 10 |
  | `board_or_investor` | Board member or investor intro | 12 |
  | `employee_network` | Someone on our team knows them | 8 |
  | `event_meeting` | Met in person at an event | 5 |
  | `other` | Other | 3 |

- **Points per introducer**: a `warm_intro_rule` can set points for a specific introducer and
  relationship (for example, "Ash, employee network: 12"). Points = introducer rule if one exists,
  else the relationship default. Range 0 to 20.
- **Confirmation**: an intro declared by a person in the web app, or by an API key with scope
  `warm_intro:declare` belonging to a person source, is confirmed. An intro declared by an agent or
  vendor is unconfirmed and counts **half** its points until a reviewer, or the named introducer if
  they are a tenant user, confirms it. Confirming publishes `intake.warm_intro.confirmed`.
- Several intros on one account: the highest points count, not the sum.
- Points travel in `intake.arrival.resolved.warmIntro` and are read with `getWarmIntro(accountId)`;
  SCO adds them to priority (it owns how).
- Changing an introducer rule or a relationship default republishes `intake.source.trust_changed`
  (`cause: warm_intro_points`) for the affected introducer's person source, so SCO rescores their
  accounts.

## Stories

### SRC-E5-S1 Declare an intro
As an AE, I want to say who introduced an account and how, so that it gets the priority it deserves.
- SRC-E5-S1-AC1 The arrival contract, the web app "Add account" form and `submit_account` accept a warm
  intro; the account page shows "Warm intro from Ash (someone on our team knows them), +8".
- SRC-E5-S1-AC2 An agent-declared intro shows "Unconfirmed, +4 of 8" with a Confirm button for
  reviewers and the named introducer.

### SRC-E5-S2 Points per introducer
As an owner, I want to set how much an intro from a given person is worth, so that intros from our
best connectors rank higher.
- SRC-E5-S2-AC1 Settings, Warm intros lists relationship defaults and introducer rules; editing points
  publishes `intake.source.trust_changed` with `cause: warm_intro_points`, and affected accounts are
  rescored within a minute.
- SRC-E5-S2-AC2 Unit test: introducer rule beats relationship default; unconfirmed halves; highest of
  several intros wins; points are clamped to 0..20.

### SRC-E5-S3 Intros in the funnel
As a CRO, I want to see how warm intros convert compared with cold sources, so that we invest in the
right relationships.
- SRC-E5-S3-AC1 Warm-intro relationship and introducer are available as dimensions in ANL's funnel by
  source (carried on `intake.arrival.resolved`).
