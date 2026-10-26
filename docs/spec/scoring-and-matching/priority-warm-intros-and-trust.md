# SCO-E2 Priority, warm intros, trust and revenue potential

Release R1 (revenue potential R2)

## Why

The queue needs one number to sort by. It should start from how well the account matches its best
offer, then reward a warm introduction from someone we trust, and lean slightly towards sources whose
accounts have turned into real pipeline before. It must stay explainable: each adjustment is shown as
its own line.

## Decision: trust is a small, visible modifier on priority

Source trust (owned by Sources and intake, a decimal 0 to 1 per person, agent and vendor) does **not**
change fit or intent. Fit and intent describe the company; trust describes how much we believe the
messenger. Trust changes priority by at most ±5 points and is always shown as its own line in the
explanation and in the score strip. Facts from a low-trust source are flagged for checking on the
account page (Accounts module); scoring does not discount them.

## Rules

Priority is computed from the **best offer's** match (SCO-E3 picks it).

```
warm_points    = min(introducer_points, warm_intro_cap)            // 0 if no warm intro
trust          = highest trust among the sources that sent this account (effective trust, see below)
trust_modifier = clamp(round((trust − trust_neutral) × 25), −trust_modifier_max, +trust_modifier_max)
priority       = clamp(match_total + warm_points + trust_modifier, 0, 100)
```

Defaults: `warm_intro_cap` 20, `trust_neutral` 0.6 (a new source starts at 0.6 so it has no effect),
`trust_modifier_max` 5.

- **Effective trust** of an arrival is computed by Sources and intake from its person, agent and vendor
  levels (SCO only consumes the number). If an account came from several sources, the highest counts.
- **Warm intro.** An arrival may name an introducer (a person known to Sources and intake, for example
  "Zach" or a partner). Points are owned and computed by Sources and intake (SRC-E5 is canonical):
  relationship defaults (15, 10, 12, 8, 5, 3), per-introducer overrides, unconfirmed intros count half,
  range 0 to 20, and the strongest intro on the account counts. SCO reads the result with
  `getWarmIntro(accountId)` and only applies `warm_intro_cap`. Warm intros skip no steps (D3).
  (spec's call, D24)
- **Not a fit stays not a fit.** If the best match is disqualified or tier `not_fit`, warm points and
  trust modifier are not applied and priority = match total.

### Revenue potential (R2)

```
base_cents      = best offer's typical deal size (cents); if unset, the offer's price minimum
size_factor     = 0.75 if employees below the offer's size range midpoint,
                  1.0 within, 1.5 above the range maximum, 1.0 if unknown
expansion_cents = base_cents × offer.expansion_rate (decimal, default 0)
potential_cents = round(base_cents × size_factor + expansion_cents)
reference_cents = practice median won deal (from win analysis) or, if under 5 wins, base_cents
band            = high if potential ≥ 2 × reference; medium if ≥ 0.75 × reference; else low
```

Revenue potential is shown, not added to priority. A leader sorting by potential can do so.

## Stories

### SCO-E2-S1 One priority number
As a leader, I want accounts sorted by one priority score, so that I review the most promising first.
- SCO-E2-S1-AC1 Priority is an integer 0 to 100 computed as above and stored on `account_score`.
- SCO-E2-S1-AC2 Given match total 65, warm points 8 and trust 0.72, priority is 65 + 8 + round(0.12 × 25)
  = 65 + 8 + 3 = 76.
- SCO-E2-S1-AC3 Given match total 98, warm points 15, trust 0.9, priority is 100 (clamped).
- SCO-E2-S1-AC4 Given tier `not_fit`, priority equals match total even with a warm intro.

### SCO-E2-S2 Warm intro points by introducer
As an owner, I want introductions from some people to count more than others, so that a CRO's intro
outranks a cold list.
- SCO-E2-S2-AC1 Warm points are the value returned by SRC's `getWarmIntro(accountId)` (SRC-E5 rules),
  capped at `warm_intro_cap`. SCO keeps no points table of its own.
- SCO-E2-S2-AC2 Changing an introducer's points rescores every account they introduced (via
  `intake.source.trust_changed` or a dedicated SRC event; whichever SRC publishes for introducer
  changes).
- SCO-E2-S2-AC3 The explanation shows "Warm intro from <name>: +<n>".

### SCO-E2-S3 Trust as a visible modifier
As a leader, I want to see when an account's rank is helped or hurt by who sent it, so that I can
judge the source myself.
- SCO-E2-S3-AC1 Trust 0.6 gives modifier 0; 0.8 gives +5; 0.4 gives −5; 1.0 gives +5 (clamped); 0.0
  gives −5.
- SCO-E2-S3-AC2 The explanation shows "Source trust 0.72 (Yasir's research agent): +3".
- SCO-E2-S3-AC3 A trust change for a source rescores only accounts that source sent.

### SCO-E2-S4 Revenue potential band (R2)
As a leader, I want a revenue potential band per account, so that I can weigh effort against size.
- SCO-E2-S4-AC1 Given typical deal $50,000 (5,000,000 cents), employees above the size range, no
  expansion, and a practice median won deal of $48,000: potential = 7,500,000 cents; 7,500,000 ≥ 2 ×
  4,800,000 is false (9,600,000), ≥ 0.75 × 4,800,000 is true, so band is medium.
- SCO-E2-S4-AC2 All money is integer cents in the tenant's currency.
- SCO-E2-S4-AC3 With fewer than 5 won deals in the practice, the reference is the offer's base deal
  size.
