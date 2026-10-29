# SCO-E3 Tiers and best offer

Release R1

## Why

Leaders think in a few buckets, not in numbers: act on it now, keep it warm, watch it, drop it. And
for each account they need one offer to lead with.

## Rules

### Tier of one offer match (carried from v1 `tierFor`)

Thresholds live in `scoring_profile.tier_thresholds` (defaults below).

| Tier | UI label | Rule |
|---|---|---|
| `not_fit` | Not a fit | disqualified, or fit < 40 |
| `act_now` | Act now | fit ≥ 60 and intent ≥ 35 and match total ≥ 60 and at least one research or trigger signal hit (pain alone is not a reason to act now) |
| `good_fit` | Good fit, no trigger yet | fit ≥ 60 and not act now |
| `watch` | Watch | everything else |

### Best offer

Among the account's offer matches: highest match total, then better tier (act now > good fit > watch >
not a fit), then higher fit, then the offer approved first (stable tie-break). The account's tier is
its best match's tier, before floors.

### Floors (an account is never ranked below what a person already said)

Applied after the best offer is picked. The higher of computed tier and any floor wins; `tier_reason`
records which.

1. **Research floor.** If the account has an ABM research tier from a research sheet (Accounts module
   holds it with its date): tier A with a signal dated within `research_floor_days` (180) = act now;
   tier A with an older signal, or tier B = good fit; tier C = watch. Never lifts a disqualified
   account.
2. **Warm-intro floor.** An account with a warm intro and best-match fit ≥ 40 is at least good fit.

Floors change the tier, not the priority number.

## Stories

### SCO-E3-S1 Tier per match and per account
- SCO-E3-S1-AC1 Given fit 65, intent 40 (total round(35.75 + 18) = 54), the match is good fit (total
  below 60).
- SCO-E3-S1-AC2 Given fit 70, intent 50 (total round(38.5 + 22.5) = 61) and at least one trigger hit,
  the match is act now; with the same numbers but only pain hits, it is good fit.
- SCO-E3-S1-AC3 Given fit 35, the match is not a fit whatever the intent.
- SCO-E3-S1-AC4 Changing a threshold in the profile and rescoring moves tiers accordingly.

### SCO-E3-S2 Best offer
As a leader, I want one offer chosen for each account, so that the brief and playbook have a lead.
- SCO-E3-S2-AC1 Given matches (offer X total 62 good fit, offer Y total 62 act now), best offer is Y.
- SCO-E3-S2-AC2 The other matches are listed on the account as "other offers that fit" with their
  totals and tiers.
- SCO-E3-S2-AC3 A leader can set a different lead offer on the account (Review and routing stores the
  override); scoring keeps computing its own best offer and shows both when they differ.

### SCO-E3-S3 Research and warm-intro floors
- SCO-E3-S3-AC1 Given research tier A with a signal 30 days old and a computed tier of watch, the
  account tier is act now with `tier_reason` research_floor, and the explanation says "Researcher
  rated A with a signal from <Mon D, YYYY>: act now".
- SCO-E3-S3-AC2 Given research tier A with a signal 200 days old, the floor is good fit.
- SCO-E3-S3-AC3 Given research tier B and a computed act now, the tier stays act now.
- SCO-E3-S3-AC4 Given a disqualified account with research tier A, the tier stays not a fit and the
  explanation names the exclusion.
- SCO-E3-S3-AC5 Given a warm intro and fit 45 with computed tier watch, the tier is good fit.
