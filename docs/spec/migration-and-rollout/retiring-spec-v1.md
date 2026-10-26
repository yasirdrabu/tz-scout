# Retiring spec v1

`docs/SPEC.md` (v1) and `docs/BUILD_PLAN.md` stay in the repo as history, each marked "Superseded by
`docs/spec/`". They are no longer the spec of record.

`CLAUDE.md` now holds general working guidelines only. Project rules that used to live there are in
this spec: stack in `architecture/stack-and-layout.md`, design and copy in
`architecture/design-and-copy.md`, tenancy and adapter rules in `architecture/data-conventions.md`
and `integrations/`.

## Where each v1 module went

| v1 module | Now |
|---|---|
| 1 Offer intake | Offers and practices |
| 2 Segment scoring | Offers and practices (segments); weights in Settings |
| 3 Message tests | Campaigns CMP-E1 |
| 4 Funnel model | Campaigns CMP-E2 (ad funnel model); the account funnel is Analytics ANL-E1 |
| 5 Lead validation agent | Shared intake steps: Sources and intake, Scoring and matching, CRM check, Review and routing (CMP-E4 shows the mapping) |
| 6 Show-up agent | Campaigns CMP-E5 |
| 7 Weekly scorecard | Analytics ANL-E5 |
| Buyers, Pulls, Signals (built after v1) | Sources and intake, Accounts, Scoring and matching |
| Push to HubSpot, Sent (built after v1) | CRM sync |
| Offer readiness, wins, call prep and review, proposals, Buying Window report (built after v1) | Offers and practices, Playbooks |
