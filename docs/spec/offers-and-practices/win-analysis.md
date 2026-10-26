# OFF-E6 Win analysis

Release R3 · Carried from `src/server/wins.ts`

## Why

Past wins say who actually buys, how much, and how fast. They set the revenue reference for scoring,
feed readiness, and suggest signal rules.

## Rules

- `won_deal` is a read model built from `crm.deal.changed` events with status won (CRM sync owns the
  CRM; this module never calls the CRM). A first-time backfill is requested from CRM sync
  (`crm:backfillWonDeals`, last 24 months or 500 deals).
- Each won deal is mapped to an offer automatically (deal name and line items against offer names and
  keywords) or by a person; unmapped deals still count for tenant-wide stats.
- Stats: count, total, median amount, median days from deal created to closed, by practice and offer.
- Patterns (AI task `win_analysis`, rules-based fallback): industries, sizes, titles of buyers, common
  triggers before the win. Suggested signal rules come with the deals that support them.

## Stories

### OFF-E6-S1 Wins page
As an owner, I want to see what our wins have in common, so that we target more like them.
- OFF-E6-S1-AC1 The Wins page shows count, total, median deal and median days to close (exact numbers,
  money right-aligned), by practice and by offer.
- OFF-E6-S1-AC2 Each won deal lists its mapped offer; a person can change the mapping.
- OFF-E6-S1-AC3 Patterns and suggested rules are listed with the number of supporting deals; "Add" on
  a rule adds it to the offer (OFF-E4-S3).

### OFF-E6-S2 Medians for scoring
- OFF-E6-S2-AC1 `medianWonDealCents(practiceId)` returns the practice median with the deal count, or
  null under 5 deals.
