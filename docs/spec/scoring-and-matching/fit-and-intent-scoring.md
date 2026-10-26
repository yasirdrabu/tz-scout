# SCO-E1 Fit and intent scoring

Release R1 · Carried from `src/lib/matching.ts` (v1), unchanged in behaviour unless stated.

## Why

A leader reviewing 100 accounts needs to know, for each one and each offer, "is this the kind of
company that buys this" (fit) and "is there a reason they would buy now" (intent). Both must be
computed the same way every time and explained.

## Rules

All of this lives in `src/modules/scoring/domain/` as pure functions with no database or network
access.

### Fit (0 to 100) for one account and one offer

| Part | Max | Full points | Partial | Zero |
|---|---|---|---|---|
| Industry | 30 | account industry matches a target industry (loose match: containment either way or a shared meaningful word) or the offer has no industry limit | 15 when industry unknown | known and not a target |
| Company size | 25 | employees in the offer's range, or no limit | 12 when unknown; 10 when within 30% outside the range | further outside |
| Revenue | 20 | revenue in band, or no limit | 10 when unknown | known and out of band |
| Region | 10 | country in target regions, or no limit (US aliases equal) | 5 when unknown | known and outside |
| Buyer on file | 15 | a person at the account whose title matches a target title, **or** who holds one of the offer's target buying roles | none | no such person |

- **Exclusions first.** If the account's domain is on the offer's excluded domains, or its industry
  matches an excluded category, fit is 0 and the match is disqualified with that reason. If the
  account itself is excluded for every offer (software vendor, unit of a larger parent) and no person
  has overridden that, every match is disqualified.
- **Hard-miss cap.** If industry or size scores 0 (known and wrong), fit is capped at 45. Right size
  alone is not a buyer.
- Part maxes come from `scoring_profile.fit_parts` and must add up to 100 (validated on save).

### Intent (0 to 100) for one account and one offer

Signal rules belong to the offer (OFF-E4). Each rule has a type, keywords, points (its weight), an
optional minimum value, and a reason.

For each rule:
1. Collect matching signals: same type, keywords found in the title or detail (keywords of 3 letters
   or fewer match whole words only), value at or above the rule's minimum. Technology rules also
   match the account's technology list.
2. Strength of one signal = recency × intensity.
   - **Recency** = 0.5 ^ (age in days / half-life). Half-life 45 days by default. Signals older than
     365 days count 0. Technology, headcount growth and workforce signals describe current state and
     do not fade (recency 1).
   - **Intensity** applies to research (intent) signals with a research score: (score − 0.40) / 0.40,
     clamped 0 to 1. So 0.60 counts half and 0.80 or more counts fully. Other types count 1.
3. Rule factor: the strongest signal counts fully; the second adds 30% of its strength; the third
   adds 15%; capped at 1. Exception: research rules use only the strongest signal, because related
   research topics are one surge under several labels.
4. Rule points = rule weight × factor, rounded to one decimal.

Intent = sum of rule points, capped at 100, rounded.

Each signal belongs to a kind: **research** (intent), **trigger** (leadership, funding, news, risk,
hiring), or **pain** (growth, workforce, tech). The kind matters for tiers (SCO-E3).

### Match total (0 to 100) for one account and one offer

`match_total = round((fit × fit_weight + intent × intent_weight) / (fit_weight + intent_weight))`,
defaults 0.55 and 0.45. If fit is below 50, the total cannot exceed fit: signals cannot lift a poor fit.

## Stories

### SCO-E1-S1 Score fit for every approved offer
As a leader, I want every account scored against every approved offer in its practice, so that I see
which offer it fits and why.
- SCO-E1-S1-AC1 Given an account whose `practice_ids` (owned by Accounts, read through
  `getAccountForScoring`) contains P, and three approved offers in P, when it is scored, then three
  `offer_match` rows exist, one per offer, each with five fit parts and a reason per part. An account
  in several practices is scored against approved offers in all of them.
- SCO-E1-S1-AC2 An account with empty `practice_ids` is scored against every approved offer in the
  tenant. (spec's call, D25)
- SCO-E1-S1-AC2b Changing an account's `practice_ids` (`accounts.account.updated` with
  `practice_ids` in `changedKeys`) rescores it.
- SCO-E1-S1-AC3 Draft and archived offers are never scored against.
- SCO-E1-S1-AC4 Given an account on an offer's excluded domain list, that match has fit 0, tier
  `not_fit` and `disqualified_reason` naming the domain.
- SCO-E1-S1-AC5 Given industry "Logistics" when the offer targets "Healthcare", fit is at most 45
  whatever the other parts score.

### SCO-E1-S2 Score intent from dated signals
As a leader, I want recent, strong signals to count more than old or weak ones, so that "why now" is
current.
- SCO-E1-S2-AC1 A signal 45 days old counts half as much as one from today; 90 days old counts a
  quarter; older than 365 days counts nothing.
- SCO-E1-S2-AC2 A research signal with score 0.60 earns half the rule's points; 0.80 earns all; 0.40
  earns none.
- SCO-E1-S2-AC3 Three hiring signals matching one rule, all from today, earn min(1, 1 + 0.3 + 0.15)
  = full rule points, not three times.
- SCO-E1-S2-AC4 Two research topics matching one research rule earn the strongest one's points only.
- SCO-E1-S2-AC5 A technology on the account matching a tech rule earns full points regardless of
  when it was seen.

### SCO-E1-S3 Combine fit and intent
- SCO-E1-S3-AC1 With fit 80, intent 40 and default weights, match total is round(0.55×80 + 0.45×40)
  = 62.
- SCO-E1-S3-AC2 With fit 45 and intent 100, match total is 45 (capped at fit).

### SCO-E1-S4 Hand-calculated test cases
As a developer, I want the domain functions tested against cases worked out by hand, so that a change
to the math is caught.
- SCO-E1-S4-AC1 The cases in "Worked examples" below pass as unit tests, plus every v1 test in
  `tests/unit/matching.test.ts` that still applies.
- SCO-E1-S4-AC2 Domain functions take `now` as an argument; tests never depend on the clock.

## Worked examples

**Example A (Miami-Dade DTPW style account, offer with industry "Government" target, size 1,000 to
50,000, no revenue limit, region US, target titles include "Chief", target buying role business owner).**

| Part | Account | Points |
|---|---|---|
| Industry | "Government transit" matches "Government" | 30 |
| Size | 2,800 employees, in range | 25 |
| Revenue | no revenue limit | 20 |
| Region | United States | 10 |
| Buyer | "Chief of Paratransit Operations", role business owner | 15 |
| **Fit** | | **100** |

Signals: an RFP re-solicitation news signal 30 days old matching a news rule worth 25 points:
recency 0.5^(30/45) = 0.630, points 25 × 0.630 = 15.7. A leadership change 90 days old matching a
25-point rule: 0.5^2 = 0.25, points 6.3. Intent = round(22.0) = 22.
Match total = round(0.55 × 100 + 0.45 × 22) = round(64.9) = 65.

**Example B (wrong industry).** Industry known and not a target (0), size in range (25), revenue
unknown (10), region match (10), buyer on file (15): sum 60, capped at 45 by the hard miss. Intent 80.
Match total before cap = round(0.55 × 45 + 0.45 × 80) = round(60.75) = 61; fit is below 50, so total =
45.

**Example C (research only).** Fit 70. One research signal, score 0.70, 10 days old, on a 40-point
research rule: intensity (0.70 − 0.40) / 0.40 = 0.75; recency 0.5^(10/45) = 0.857; strength 0.643;
points 40 × 0.643 = 25.7. Intent 26. Total = round(38.5 + 11.7) = round(50.2) = 50.
