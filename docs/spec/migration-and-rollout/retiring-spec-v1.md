# Retiring spec v1

`docs/SPEC.md` (v1) and `docs/BUILD_PLAN.md` stay in the repo as history. They are no longer the spec of
record. When this spec is accepted, add one line at the top of each:

> Superseded by `docs/spec/` (Taazaa Scout spec v2). Kept as history.

`CLAUDE.md` should point to `docs/spec/README.md` instead of `docs/SPEC.md` and `docs/BUILD_PLAN.md`,
and its stack line should match `architecture/stack-and-layout.md` (Drizzle, NATS, better-auth). That
edit is part of R0.

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
