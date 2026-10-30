# CRM-E4 Handoff batches and messages

Release R1 · Module CRM

## Why

A leader often assigns many accounts at once. Reps should get one message per push, not a CRM alert
per task, and the leader needs one place (Sent) to see what went to whom and whether they acted.

## Rules

- Handoffs created within the same leader action (a bulk assign) share one `crm.handoff_batch`.
  A single assignment makes its own batch.
- Batch name: "<Mon D> · <n> to <first name>, <n> to <first name>" (as today, `batchName`).
- A reader sees only the handoffs of accounts inside their data limit, in the list, the detail, the
  follow-through counts and Not sent yet. The name and messages name every account, so when any handoff
  of a batch is outside the reader's limit the batch has no name (`name` null) and each message has
  `text` null with `restricted` true. A batch with nothing the reader can see is left out of the list
  and is not found.
- One message per seller per batch, written by a pure function (carried from `src/lib/handoff.ts`):
  greeting, numbered accounts with offer, first buyer and CRM link, what's in the CRM, and the ask
  (first touch within two working days, mark tasks done). Signed with the leader's first name.

## Stories

### CRM-E4-S1 Sent view
As a leader, I want handed-off accounts grouped by batch in a Sent view, so that I can see what went to
whom.
- CRM-E4-S1-AC1 Sent lists batches newest first, each with its handoffs, seller, status and follow-through
  counts (CRM-E5).
- CRM-E4-S1-AC2 Handed-off accounts leave the review queue and never return to it from a new arrival;
  "Back to queue" (Review and routing) is the only way back.

### CRM-E4-S2 One message per rep
As a leader, I want a ready message per rep, so that I can post it in Teams in one copy.
- CRM-E4-S2-AC1 Each batch shows one message per seller with a Copy button; copying records `copied_at`.
- CRM-E4-S2-AC2 The message lists only accounts whose handoff completed; failed ones are listed under
  the message as "Not sent yet" with the reason.
- CRM-E4-S2-AC3 The text matches the current `handoffMessage` output for the same input (snapshot test).
