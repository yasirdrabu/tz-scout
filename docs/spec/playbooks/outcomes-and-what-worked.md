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
| `meeting` | `crm.activity.observed` meeting held; `campaigns.meeting.held` (R4, booking flow); call review; or by hand |
| `opportunity` | `crm.deal.changed` first open deal |
| `won` | `crm.deal.changed` won, with amount |
| `lost` | `crm.deal.changed` lost; or by hand with a reason |
| `no_response` | plan completed with no reply or meeting |

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
