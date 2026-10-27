# SRC-E1 Source registry and trust

Status: Draft · Release: R1 (registry, limits, initial status), R3 (trust scores)

## Why

Scout must always answer "who sent this, and how good are their accounts?" A source is not one thing:
an AE (a person) runs a research agent (an agent) that pulls from Apollo (a vendor). Each of those can
be good or bad independently, so each gets its own trust score (D5).

## Rules

### Source kinds and the hierarchy

| Kind | Example | Parent | Typical way in |
|---|---|---|---|
| `person` | Yasir, a partner's contact, an analyst | none | web app, CSV, API key of their own |
| `agent` | "Yasir-AI-Transformation-Agent" | a `person` (its owner) | MCP, API key |
| `vendor` | Apollo, Vibe, a lead-list vendor | none | scheduled pull, enrichment, file import, vendor API key |
| `partner` | A referral partner firm | none | API key, CSV |
| `crm` | "HubSpot marketing qualified" | none | inbound webhook |
| `web_form` | "taazaa.com contact form" | none | inbound webhook |
| `scheduled_pull` | "Logistics ops leaders, weekly" | a `vendor` | scheduler via ENR |

- Every arrival records a **source chain**: `person_source_id`, `agent_source_id`,
  `vendor_source_id`. Any may be empty, at least one is set.
  - An agent's key fills `agent_source_id` and, from the agent's parent, `person_source_id`.
  - The arrival may name the vendor it used (`via_vendor` in the payload, matched to a registered
    vendor by key, e.g. `apollo`); unknown vendor names are kept in the payload and the arrival is
    accepted without a vendor link.
  - A person importing a CSV fills `person_source_id` (and `vendor_source_id` if they pick "this list
    came from" a vendor on the import page).
  - `partner`, `crm`, `web_form` sources fill the slot closest to their nature: partner as person
    level, crm and web form as vendor level. This keeps trust to three levels.
- Each API key belongs to exactly one source (TEN stores `key.source_id`). A person can have many
  agents; an agent has exactly one owner.
- Source settings: `status` (`active`, `paused`, `archived`), `daily_arrival_cap` (default 500, D8;
  enforced through INT `checkCap`),
  `initial_review_status_key` (default `unvetted` for `agent`, `vendor`, `partner`,
  `scheduled_pull`; `needs_review` for `person`, `crm`, `web_form`; the list of statuses lives in REV),
  `auto_enrich_allowed` (always false in this version, D7).
- A paused source's keys get `403` ("This source is paused") and nothing is stored; an archived source
  can't be used and its keys are revoked (TEN).

### Trust scores

Trust is a decimal from 0 to 1. Every source starts at **0.60**. Shown as a whole number out of 100 in
the UI ("Source trust 72").

**Arrival quality.** Each resolved arrival earns a quality value from the furthest funnel stage its
account reached after that arrival (stages from the event catalog):

| Furthest stage | Quality |
|---|---|
| Declined at review, or declined by seller with a "bad fit" or "bad data" reason | 0.00 |
| Arrived, no decision after 30 days | 0.10 |
| Reviewed | 0.30 |
| Assigned (accepted) | 0.50 |
| Engaged | 0.70 |
| Opportunity | 0.90 |
| Won | 1.00 |

Arrivals less than 30 days old with no review decision yet are left out (not judged yet). If several
sources sent the same account, each gets the account's quality (credit goes to every source that sent
it before assignment). Arrivals that attached to an account already assigned get no credit (they
brought nothing new to the decision).

**Formula** (nightly, and immediately on a conflict loss):

```
weight_i  = 0.5 ^ (age_days_i / 180)                  # older arrivals count less
trust     = (10 × 0.60 + Σ quality_i × weight_i) / (10 + Σ weight_i)
trust     = max(0, trust − 0.01 × conflicts_lost_in_last_180_days)
```

The `10 × 0.60` prior keeps a new source near 0.60 until it has real history. Computed separately for
each level: a person's trust uses every arrival in which they are the person level (directly or
through any of their agents); an agent's uses its own arrivals; a vendor's uses every arrival that
names it.

**Effective trust of an arrival** (what the account page and scoring see):
`0.4 × person + 0.3 × agent + 0.3 × vendor`, re-weighted over the levels that are present.

A change of 0.02 or more publishes `intake.source.trust_changed`. It is also republished (with
`from = to`) when a warm-intro introducer's points change, so SCO rescores that introducer's accounts
(SRC-E5).

**How scoring uses trust** (owned by SCO, stated here so both sides agree): source trust moves
priority by at most ±5 points and never changes fit or intent. SCO reads it with `getTrust(chain)`.

## Data

`source`, `source_trust_history`, `arrival_outcome` (see index). `arrival_outcome` is updated by
consumers of `routing.status.changed` (including send-back and decline notes, which become feedback),
`routing.stage.changed` (furthest stage reached), `routing.assignment.accepted`,
`routing.assignment.declined`, `crm.deal.changed`, `playbooks.outcome.recorded` and
`accounts.conflict.resolved`; on `accounts.account.merged` rows for the merged account move to the
survivor.

## Stories

### SRC-E1-S1 Register sources
As an owner, I want to register people, agents, vendors, partners and other sources, so that every
arrival is tied to who sent it.
- SRC-E1-S1-AC1 An owner can create a source of any kind with a name; an `agent` requires an owner
  person; a `scheduled_pull` requires a vendor parent.
- SRC-E1-S1-AC2 Creating a person source for a tenant user links it to that user; one person source
  per user.
- SRC-E1-S1-AC3 The Sources page shows the registry as a tree (person → agents; vendor → scheduled
  pulls), each row with kind, status, trust, arrivals in the last 30 days, and keys (link to TEN).
- SRC-E1-S1-AC4 Seed data registers vendor sources `apollo`, `vibe`, `hubspot_qualified`, and one
  person source per seeded user.

### SRC-E1-S2 Caps and initial status per source
As an owner, I want each source to have a daily cap and a starting review status, so that no source
can flood the queue and unvetted sources are marked as such.
- SRC-E1-S2-AC1 Default daily cap is 500 arrivals per source per tenant day; an owner can change it
  from 0 to 10,000. The cap is checked with INT `checkCap` before an arrival is stored.
- SRC-E1-S2-AC2 Given a source has used its cap, when it sends a single arrival, then the API returns
  `429` with `Retry-After` until the next tenant day and nothing is stored; batch items past the cap
  are stored and rejected `daily_cap_reached`, so the caller can see which ones to resend.
- SRC-E1-S2-AC3 The starting review status defaults by kind as in Rules and can be changed to any
  status REV allows; it travels in `intake.arrival.resolved.initialReviewStatusKey`.
- SRC-E1-S2-AC4 Pausing a source makes its keys get `403` with "This source is paused" until resumed.

### SRC-E1-S3 Trust scores at every level (R3)
As a leader, I want to see how trustworthy each person, agent and vendor is, so that I know how much
to rely on what they send.
- SRC-E1-S3-AC1 Trust is computed nightly with the formula above; a unit test covers: a new source
  (0.60), 20 fresh won arrivals (about 0.87), 40 fresh declined arrivals (0.12), decay (a 360-day-old
  arrival counts a quarter as much as a new one).
- SRC-E1-S3-AC2 Each conflict lost lowers that source's trust by 0.01 immediately (D4 minor drop).
- SRC-E1-S3-AC3 Person, agent and vendor trust are computed independently from their own arrivals.
- SRC-E1-S3-AC4 The account page shows effective trust for each source that sent the account, with a
  breakdown on hover: "Person 0.64, agent 0.71, vendor 0.55".
- SRC-E1-S3-AC5 The source page shows a 12-month trust trend and the sample size behind it.

### SRC-E1-S4 Feedback to sources
As an agent owner, I want my agent to learn why its accounts were declined or its facts were
overruled, so that it sends better accounts next time.
- SRC-E1-S4-AC1 On a conflict lost, a review decline or a seller decline, a `source_feedback` row is
  written for every source in the arrival's chain, with the reason and any note, and
  `intake.feedback.recorded` is published.
- SRC-E1-S4-AC2 `GET /v1/feedback` and `list_my_submissions` return feedback for the principal's
  source only.
