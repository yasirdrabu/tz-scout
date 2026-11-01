# SCO-E6 Four-weight scoring model

Release: scoring redesign (web-ui Decision 21), before the R2 playbooks plan. It replaces the match
total, the trust modifier, the three Act now thresholds and the `fit < 40` Not a fit rule of SCO-E1,
SCO-E2 and SCO-E3; everything else in those epics (fit parts, intent, exclusions, hard-miss cap,
best offer tie-breaks, floors, hand-set tiers) stays.

## Why

The mockup's Scoring weights screen (screens.md §21f) explains a score a leader can tune: four scores
out of 100, weighted to 100, and one cutoff per tier. The old model (a fit and intent blend, a trust
modifier and three Act now thresholds) can't be shown that way.

## Decisions (the user, 2026-11-01)

1. Excluded accounts stay **Not a fit**, outside the score. Low scores are **Nurture**. Five tiers:
   Act now, Good fit, Watch, Nurture, Not a fit.
2. **Act now** needs the cutoff **and** at least one research or trigger signal hit, as today.
3. **Warm intros** keep both the bonus points (capped by `warm_intro_cap`, priority capped at 100) and
   the Good fit floor. The research floor and hand-set tiers stay.
4. **Revenue potential** is computed now from data Scout has (below), not left empty until R2.

## Rules

### Four scores per offer match (each 0 to 100)

| Score | From |
|---|---|
| Fit | SCO-E1 fit, unchanged (exclusions, hard-miss cap at 45) |
| Buying intent | SCO-E1 intent, unchanged |
| Revenue potential | below |
| Source trust | `round(effective trust × 100)` of the account (SCO-E2: the highest of its sources). Every source is 0.60 until R3, so this is 60 for everyone |

### Revenue potential score

The SCO-E2 formula, turned into a score:

```
base_cents      = offer.typical_deal_cents, else offer price minimum, else none
size_factor     = 0.75 below the offer's size range midpoint, 1.0 within or unknown, 1.5 above the max
potential_cents = round(base_cents × size_factor + base_cents × offer.expansion_rate)
reference_cents = median won deal in the offer's practice when it has 5 or more wins, else base_cents
                  (won deals carry no practice yet, so until the R3 win analysis it is base_cents)
revenue score   = clamp(round(50 × potential_cents / reference_cents), 0, 100)
band            = high at score 100 (potential ≥ 2 × reference), medium at 38 or more, else low
```

No base (no deal size and no price minimum) gives score 50 with the reason "No deal size on {offer}",
band null. `account_score.revenue_potential_cents` and `revenue_band` are the best offer's.

### Match score

```
score = round((w_fit × fit + w_intent × intent + w_revenue × revenue + w_trust × trust) / 100)
```

The weights are whole numbers, 0 to 60 in steps of 5, adding to 100. Defaults **Fit 40, Buying intent
25, Revenue potential 15, Source trust 20**. If fit is below 50 the score can't exceed fit (signals,
size or trust can't lift a poor fit). The score is stored in `offer_match.match_total` and
`account_score.match_total` (the column keeps its name).

### Tier of one match

Cutoffs live in the profile: `act_now`, `good_fit`, `watch`, defaults **75, 55, 35**. Each must be higher
than the one below, `act_now` at most 100 and `watch` at least 1.

| Tier | UI label | Rule |
|---|---|---|
| `not_fit` | Not a fit | disqualified (an exclusion, SCO-E1) |
| `act_now` | Act now | score ≥ act_now cutoff and at least one research or trigger signal hit |
| `good_fit` | Good fit | score ≥ good_fit cutoff and not act now |
| `watch` | Watch | score ≥ watch cutoff |
| `nurture` | Nurture | below the watch cutoff |

Tier order for best offer and floors: act now > good fit > watch > nurture > not a fit.

### Priority

`priority = min(100, best match score + warm points)` where warm points are capped by
`warm_intro_cap` (20). Not a fit: priority = score, no warm points. There is no trust modifier any
more: trust is one of the four weights. `account_score.trust_modifier` is written 0.

### Floors and hand-set tiers

Unchanged (SCO-E3, Decision 4): research floor, warm-intro floor (best-match fit ≥ 40 → at least Good
fit), a hand-set tier kept across rescores. A floor never lifts Not a fit. A hand-set tier may now be
`nurture`.

### Profile and settings

`scoring_profile` drops `fit_weight`, `intent_weight`, `trust_modifier_max` and the old
`tier_thresholds` shape, and gains `weights {fit, intent, revenue, trust}` and `tier_cutoffs {act_now,
good_fit, watch}`. Fit parts, half-life, maximum signal age, warm intro cap, trust neutral and research
floor days stay (not on the §21f screen).

- `GET /api/v1/scoring/profile` (`scoring:manage`, exists): gains `weights`, `tier_cutoffs` and
  `defaults` (the default profile) so the screen can show and restore them.
- `POST /api/v1/scoring/profile:preview` with draft weights and cutoffs: tier counts before and after
  for accounts scored in the last 90 days, and 8 sample accounts (name, the four scores, score before
  and after, tier before and after), computed without writing (C8).
- `PUT /api/v1/scoring/profile` (exists, partial): takes `weights` and `tier_cutoffs` in place of
  `fit_weight`, `intent_weight`, `trust_modifier_max` and `tier_thresholds`; validates (weights add to 100, each 0 to 60 in steps of 5; cutoffs
  ordered as above; errors name the field and say what to fix), bumps the profile version, audits
  before and after, publishes `scoring.rules.changed`, which rescores every account in the workspace
  (Decision 22). Hand-set tiers stay.

### Contracts that change

- The tier value set gains `nurture` everywhere it is listed (events, read models, API enums, filters,
  the web-ui tier chips and filters, and the HubSpot `taazaa_tier` property options and value map,
  which gain "Nurture"). Consumers that act on tiers (the brief drafts only for Act now and
  Good fit, assignment, CRM tier mapping) treat `nurture` like `watch` unless their spec says otherwise.
- The account page's score strip shows Revenue potential and Source trust as values out of 100 with
  their reason; Priority's note names the Act now cutoff ("Act now starts at {act_now} with a
  research or trigger signal.").
- Explanations (SCO-E4) list the four scores with their weights ("Fit 82 × 40%") and the warm intro
  line; the trust modifier line goes.

### Migration and rescore

The profile migration maps every tenant to the defaults above (no tenant has edited weights: there is
no editor yet). After deploy, `scout rescore` (a new CLI command: every active workspace, or
`--tenant <slug>`) writes the new scores; each change is a `score_change` with cause
`rules_changed`.

## Stories

### SCO-E6-S1 Score with four weights
- SCO-E6-S1-AC1 Fit 80, intent 40, revenue 50, trust 60, default weights: score =
  round((3200 + 1000 + 750 + 1200) / 100) = round(61.5) = 62 → Good fit.
- SCO-E6-S1-AC2 Fit 100, intent 80, revenue 75, trust 60 with a trigger hit:
  round((4000 + 2000 + 1125 + 1200) / 100) = round(83.25) = 83 → Act now; with only pain hits, Good fit.
- SCO-E6-S1-AC3 Fit 45 (hard miss), intent 100, revenue 100, trust 60: weighted 70, capped at fit →
  45 → Watch.
- SCO-E6-S1-AC4 Fit 20, intent 0, revenue 50, trust 60: round((800 + 0 + 750 + 1200) / 100) = 28,
  capped at fit 20 → 20 → Nurture.
- SCO-E6-S1-AC5 An account on an offer's excluded domains is Not a fit whatever its scores, and a warm
  intro doesn't lift it.

### SCO-E6-S2 Revenue potential score
- SCO-E6-S2-AC1 Typical deal $50,000, employees above the size range, no expansion, practice median won
  deal $48,000 over 5+ wins: potential 7,500,000 cents; score round(50 × 7.5 / 4.8) = 78; band medium.
- SCO-E6-S2-AC2 Fewer than 5 wins, employees within the range: score 50.
- SCO-E6-S2-AC3 An offer with no deal size and no price minimum: score 50, reason "No deal size on
  {offer}".

### SCO-E6-S3 Priority with warm intros
- SCO-E6-S3-AC1 Score 62 and warm points 8: priority 70, tier Good fit.
- SCO-E6-S3-AC2 Score 96 and warm points 15: priority 100.
- SCO-E6-S3-AC3 Score 40 (Watch), warm intro and fit 45: tier Good fit by the floor, priority 40 +
  warm points.

### SCO-E6-S4 Edit weights and cutoffs (screens.md §21f)
- SCO-E6-S4-AC1 Weights adding to 95 are rejected: "Weights add up to 95. Make them add up to 100."
- SCO-E6-S4-AC2 Cutoffs Good fit 80 and Act now 75 are rejected: "Act now has to start higher than
  Good fit."
- SCO-E6-S4-AC3 The preview changes nothing: the same `GET` before and after shows the same scores.
- SCO-E6-S4-AC4 Saving rescores every account in the workspace; a hand-set tier stays; the audit entry
  has before and after.
- SCO-E6-S4-AC5 A workspace's weights never change another workspace's scores.
