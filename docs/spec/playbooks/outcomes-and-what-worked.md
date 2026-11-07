# PLB-E6 Outcomes and what worked

Release R3

## Why

"End-to-end clarity on what is working" needs outcomes tied to accounts and to the plays that came
before them. Every reply, meeting, opportunity and win is a signal of what worked; together they make
a composite score per account and, rolled up, per step type, template, source and offer.

## Rules

### Outcomes

| Kind | Recorded from |
|---|---|
| `reply` | `crm.activity.observed` with an inbound email or reply; or by hand |
| `meeting` | `crm.activity.observed` meeting, which is the booking (a meeting counts when it is booked, not when it is held); `campaigns.meeting.held` (R4, booking flow); call review; or by hand |
| `opportunity` | `crm.deal.changed` first open or won deal for the plan |
| `won` | `crm.deal.changed` won, with amount |
| `lost` | `crm.deal.changed` lost; or by hand with a reason. A deal first seen as lost records only `lost`. |
| `no_response` | `playbooks.plan.no_reply` fires: the last step closed and nobody replied or booked since accept |

The same CRM activity or deal never records the same outcome twice (`ref` unique per kind).

### Credit to steps

Each outcome credits the plan steps marked done in the 14 days before it (equal shares). If none, it
credits "no recent step". This is a simple, explainable attribution, not a model.

### What worked score (0 to 100) per account

Highest outcome reached: none 0, no response 5, reply 25, meeting 50, opportunity 75, won 100. Lost
after an opportunity is 60; lost before is the highest earlier outcome. Recomputed on every outcome.

Roll-ups (computed by Analytics from `playbooks.outcome.recorded`): average what-worked score and
outcome counts by template, step type, source, practice, offer and seller.

## Stories

### PLB-E6-S1 Record outcomes
As an AE, I want replies, meetings and deals to show up on the account without typing them, so that
the record is complete.
- PLB-E6-S1-AC1 A CRM email reply observed after handoff records a `reply` outcome within a minute of
  CRM sync seeing it.
- PLB-E6-S1-AC2 A manual outcome needs kind and date; won and opportunity accept an amount in dollars
  stored as cents.
- PLB-E6-S1-AC3 Each outcome lists the steps it credits.

### PLB-E6-S2 What worked score
- PLB-E6-S2-AC1 Given outcomes reply then meeting, the score is 50; adding opportunity then lost gives
  60.
- PLB-E6-S2-AC2 The score appears on the account page and in the queue as a column once assigned.

## As built (R3c-2)

Playbook outcomes and rates. Owner defaults (2026-11-07): outcomes come from events with 14-day step credit, with no manual
outcomes and no what-worked score.

- **Meeting means booked.** The CRM activity `meeting` is the booking (R2d) and the tile reads "Booked a meeting". Its `externalId` is the
  `ref`, so a later update to the same meeting is not a second outcome. The line "meeting held" above is amended.
- **Outcomes belong to a plan.** An outcome belongs to the account's latest plan that had started by `occurredAt` (its first accept:
  `least(created_at, accepted_at)`, because `accepted_at` moves forward on a resume or takeover), in any
  status, so a reply after the plan was stopped or completed still counts for it. With no such plan nothing is recorded: outcomes are
  about plays. Outcomes are only recorded for accounts with a plan accepted before them.
- **Deals.**
  - `opportunity` is recorded once per plan, on the first deal event (open or won) for that plan, ref `{system}:{dealExternalId}`.
    A deal opened before the plan's accept records no opportunity.
  - `won` is recorded when a deal's status becomes `won` and `lost` when it becomes `lost`, once per deal, with `amountCents`.
    A deal first seen as lost records only `lost`.
  - `occurredAt` is `openedAt` for opportunity and `closedAt` for won and lost, falling back to `observedAt`.
- **no_response** is recorded when `playbooks.plan.no_reply` fires; its ref is the plan id.
- **Credit.** The plan's steps with status `done` and `done_at` in `[occurredAt - 14 days, occurredAt]`, in equal shares; none means
  "no recent step". A step done exactly 14 days before counts; one done 14 days and 1 ms before, or after the outcome, does not.
- **Finished.** `finished_at` is set once, the first time the plan becomes `completed` or `stopped`, or its last open step closes while it
  is active. Abandoned plans never finish; reopening a step does not clear it.
- **Rates.** Finished is the plans on the template with `finished_at` in the last 90 days. Replied, Booked a meeting and Won are those
  plans with at least one `reply`, `meeting` or `won` outcome on the plan, at any time. They are tenant-wide, like Running, because they
  are counts that name no account. Nothing finished reads "–" (and Won "None yet"), never 0%.
- **Merges.** Outcomes move to the survivor with the plans.
- **Backfill.** `scout backfill-outcomes <slug>` replays CRM reply and meeting activity, cached deals and plans with `no_reply_at`
  through the same recording, so events publish and Analytics fills `step_credit`. Run it once per workspace, after
  `backfill-journeys`. It is safe to run again.
- **Out of scope** (still R3 or later): outcome lists on the account page, manual outcomes (PLB-E6-S1-AC2), the what-worked score
  (PLB-E6-S2), practice and offer filters on what worked (they arrive with the flywheel, R3c-3), CSV export, and
  `jobs.history.republish` for outcomes.
