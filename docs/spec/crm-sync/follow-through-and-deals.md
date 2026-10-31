# CRM-E5 Follow-through, activity and deals

Release R1 (follow-through, activity and deal events, HubSpot first; D32). Analytics views over these
events arrive in R3, but the events and funnel stages are recorded from R1 so history exists.

## Why

Scout only learns what works if it sees what reps did and what deals came of it. The CRM stays the
record; Scout reads, never writes, deal state.

## Rules

- **Baseline:** at handoff, Scout stores the counts already on the company (emails, calls, meetings,
  deals). Follow-through shows counts above the baseline, so a previous owner's history doesn't count.
- **How changes arrive (R1):** scheduled polls are the primary path: activity every 15 minutes, deals
  hourly (D28). CRM webhooks, where set up by hand and verified with `webhook_client_secret`, are an
  optional faster path. Both feed the same idempotent job. The activity poll only picks the accounts due
  a check (up to 200, least recently checked or queued first) and queues one `crm.sync` per account;
  each sync reads its account in its own job, so one slow or failing account does not hold up the rest.
  The deal poll reads at most 1,000 deals a run; after a full page it continues from the last deal's
  modified time on the next run.
- **Activity:** each new email, reply, call, meeting or completed task on a handed-off company becomes
  one `crm.activity` row and one `crm.activity.observed` event. Activities are keyed by
  (`system`, `external_id`) so a webhook and a poll never double count.
- **Replies:** where the CRM marks an email as inbound from the account's domain, kind is `reply`.
- **Who acted:** each activity carries the CRM owner who did it and, when a membership's `crm_owner_ids`
  holds that owner, the Scout user. Review and routing treats the assigned seller acting on the account
  as acceptance.
- **Backfill for win analysis:** `backfillWonDeals` reads closed-won deals (default last 24 months or
  500) for Offers and practices' win analysis, read only, through `gateway.call`.
- **Deals:** any deal on a linked company is cached in `crm.deal`. A change in status (new deal = open,
  closed won, closed lost) or amount publishes `crm.deal.changed`. Deals on companies Scout never
  handed off are read only if the company is linked to a Scout account (for win analysis).
- **Read only:** follow-through never writes to the CRM.

## Stories

### CRM-E5-S1 Follow-through per account
As a leader, I want to see for each handed-off account whether the rep acted, so that nothing stalls
unseen.
- CRM-E5-S1-AC1 Sent and the account page show per account: tasks done and overdue, and emails, calls,
  meetings and deals since handoff.
- CRM-E5-S1-AC2 "Check follow-through" refreshes now; scheduled checks run every 15 minutes for
  activity and hourly for deals.
- CRM-E5-S1-AC3 Counts never include activity that existed before the handoff (baseline test).

### CRM-E5-S2 Activity events
As the analytics and playbooks modules, I want an event for each real touch, so that the funnel's
Engaged stage and playbook outcomes are automatic.
- CRM-E5-S2-AC1 Each activity is published once as `crm.activity.observed`, whether it came by webhook,
  poll or both.
- CRM-E5-S2-AC2 A CRM task linked to a playbook step that becomes completed publishes
  `crm.activity.observed` with kind `task_done`, `stepId` and `taskExternalId`, and Playbooks marks the
  step done.
- CRM-E5-S2-AC3 Each activity carries `actorCrmOwnerId`, and `actorUserId` when the owner is linked to
  a Scout user; an email sent by the assigned seller has `actorUserId` = that seller.

### CRM-E5-S3 Deal events
As a CRO, I want Scout to know when a deal opens, is won or is lost, so that cost per won client and
win rate by source are real.
- CRM-E5-S3-AC1 A new deal on a linked company publishes `crm.deal.changed` with status `open`.
- CRM-E5-S3-AC2 Closing a deal publishes `crm.deal.changed` with `won` or `lost`, the amount in cents
  and `closedAt`.
- CRM-E5-S3-AC3 Re-reading an unchanged deal publishes nothing.
- CRM-E5-S3-AC4 Scout never changes a deal in the CRM.
- CRM-E5-S3-AC5 `backfillWonDeals` returns closed-won deals in the window with amount in cents, close
  date, company and contacts, and makes no writes.

### CRM-E5-S4 Webhook intake
As a developer, I want CRM webhooks verified and handled asynchronously, so that a slow consumer never
makes the CRM retry.
- CRM-E5-S4-AC1 HubSpot deal and engagement events arrive at `POST /api/v1/inbound/hubspot/{connectionId}`
  (owned by SRC, which verifies the signature and answers within 1 second); they are passed to
  `handleCrmWebhook`, which stores the raw body and publishes `jobs.crm.sync` for each affected company.
- CRM-E5-S4-AC2 Without webhooks (the R1 default), the 15-minute activity poll and hourly deal poll
  are the only path and produce the same events.
