# CRM-E3 Handoff push

Release R1 · Module CRM

## Why

The moment a leader assigns an account, the rep should find it in the CRM with everything Scout
knows, without anyone copying text. Today's push (`src/server/crm.ts`) does this for HubSpot; this
epic keeps its rules and makes it event driven, retried and visible.

## Flow

1. `routing.assignment.created` arrives. The consumer creates a `crm.handoff` (status `queued`) and
   publishes `jobs.crm.handoff.push` through the outbox. Ordered by `accountId`. Every job that writes to the CRM for an account (push, undo, person push, sync) first takes the advisory lock `crm:<tenant>:<account>`.
2. The job loads the account and people from Accounts, and the handoff package (scores, best offer,
   fit parts, signals as scored, offer and case studies, brief, opener, follow-up sequence, plan
   steps) from the registered `HandoffPackageProvider` (Playbooks), then builds the note (CRM-E3-S3).
   CRM never calls Scoring, Offers or Playbooks directly.
3. Ownership decision (CRM-E3-S2). If it stops, status `needs_decision` and
   `crm.handoff.needs_decision` is published.
4. Upsert company, then people (at most 10, primary buyer first), note, first-touch task, follow-up
   tasks, plan step tasks. Each write records a `crm.link`.
5. Read the follow-through baseline (counts already on the company).
6. Mark `completed`, publish `crm.handoff.completed`, add to the handoff batch (CRM-E4).

Target: p95 under 10 seconds from `routing.assignment.created` to `crm.handoff.completed` for an
account with up to 10 people, when the CRM responds normally.

## Ownership rule (carried from `src/lib/ownership.ts`, pure and tested)

| Situation in the CRM | Result |
|---|---|
| No company, no owner, or our rep already owns it | Assign our rep |
| Owned by the owner Scout set on an earlier push | Assign our rep |
| Has an open deal or is a customer, "push anyway" not chosen | Stop: needs a decision |
| Has an open deal or is a customer, "push anyway" chosen | Push the context, keep their owner |
| Owned by someone inactive, or take-over setting on | Assign our rep, record who it was taken from |
| Owned by someone active, take-over setting off | Stop: needs a decision |

The note records "reassigned from <name>" when ownership was taken.

## Note content

The note carries everything the account page shows, capped under the CRM's note limit (HubSpot:
65,000 characters; sections dropped from the bottom up when over): tier and what it means, why now,
signals in short, how to approach (primary buyer, angle, opener, who wrote the brief), the offer
(promise, price range, sales cycle, buyers, proof, case studies), why it fits (each fit part), every
scored signal with date, source link and how to read it, research topics, other offers that fit,
what would make it stronger, all people with buying role and email quality, company description and
tech stack, data date, the source path (who sent it, through which agent and vendor), the leader's
assignment note, and a link back to Scout.

AI-written text is labelled with how it was made ("Written by Claude" or "Assembled from rules").
Research intent, lawsuits and breaches are never quoted in text meant for the buyer (openers).

## Stories

### CRM-E3-S1 Push on assignment
As a leader, I want the account in the rep's CRM within seconds of assigning it, so that the rep can
act the same day.
- CRM-E3-S1-AC1 Given an assignment is created, then a handoff is queued once, even if the event is
  delivered twice.
- CRM-E3-S1-AC2 Given the CRM responds normally, then the handoff completes within 10 seconds (p95).
- CRM-E3-S1-AC3 The push starts on `routing.assignment.created`; acceptance is not awaited (REV-E3).
- CRM-E3-S1-AC5 The assignment's `ownershipDecision` from REV's preflight is applied. If the CRM state
  changed since the preflight so the rule now says stop, the handoff goes to `needs_decision` and
  `crm.handoff.needs_decision` is published instead of pushing.
- CRM-E3-S1-AC4 The CRM owner is `crmOwnerId(ctx, sellerUserId, system)`. If it returns nothing, the
  account is not pushed; the handoff fails with "This seller isn't linked to a CRM owner" and is not
  retried.

### CRM-E3-S2 Respect people already working the account
As a rep, I want Scout never to take an account I'm actively working, so that I trust it.
- CRM-E3-S2-AC1 The ownership table above is implemented as a pure function with a unit test per row,
  used by both `preflightOwnership` (REV's assign dialog) and the push.
- CRM-E3-S2-AC2 A stopped handoff shows on the account page and in the review queue with the reason and
  two buttons: "Push and keep their owner" and "Cancel assignment".
- CRM-E3-S2-AC3 People pushed with the company get the same owner decision as the company.

### CRM-E3-S3 Full context note, never overwriting a rep
As a rep, I want one note with the whole story, and I never want my edits lost, so that I can rely
on it.
- CRM-E3-S3-AC1 The note contains every section listed above that has data, in that order.
- CRM-E3-S3-AC2 The note's fingerprint is stored. On re-push, if the CRM note still matches the
  fingerprint it is updated in place; if a person edited it, a new note is added and the old one kept.
- CRM-E3-S3-AC3 Existing company and person values in the CRM are never blanked by a push; empty Scout
  values are not sent.
- CRM-E3-S3-AC4 Over the note limit, lower sections are dropped and a line "More in Scout" with the link
  is added.

### CRM-E3-S4 Tasks for the first touch, follow-ups and plan steps
As a rep, I want dated tasks in my CRM, so that I know what to do when.
- CRM-E3-S4-AC1 A first-touch task due on the handoff day carries the opener and the primary buyer.
- CRM-E3-S4-AC2 Follow-up tasks are created for days 3, 7 and 14 (tenant setting), each with the email
  subject and body from the account's follow-up sequence.
- CRM-E3-S4-AC3 Each account plan step owned by the seller becomes a task with the step's due date; a
  step completed in Scout closes its task; a task completed in the CRM marks the step done
  (via CRM-E5).
- CRM-E3-S4-AC4 Re-pushing updates tasks in place. A task already completed in the CRM is not reopened;
  a fresh one is created only if the step was reopened in Scout.

### CRM-E3-S5 Retries and failures people can see
As a leader, I want to know when a push failed and why, so that no assigned account silently sits
outside the CRM.
- CRM-E3-S5-AC1 Retryable errors (timeouts, 429, 5xx, and transient database errors) are rethrown and retry after 30 seconds, 2, 10 and 30 minutes, then an hour (a create that timed out may still land in HubSpot, whose search index lags); each run counts an attempt on the handoff before it takes the account lock. The job is delivered up to 7 times (`maxDeliver` 7) and the first 6 deliveries are push attempts; the 7th only marks a handoff `failed` when the job died, so a handoff never stays `running`.
- CRM-E3-S5-AC2 After the last attempt (attempt 6), or on a non-retryable error (bad token, missing scope,
  an answer Scout could not read, a seller with no CRM owner, an account with no website), status is `failed`, `crm.handoff.failed` is published, and the account page and Sent
  view show the reason in plain words with a Retry button.
- CRM-E3-S5-AC3 A failed handoff never leaves half-linked records: links are written per successful
  write, each in its own transaction, and a retry resumes from what already exists. Reasons are plain words of at most 300 characters: "HubSpot refused the token. Enter a new one in Integrations.", "HubSpot needs another permission: <scope>.", "This seller isn't linked to a CRM owner", "HubSpot was busy and every retry failed.", "HubSpot sent an answer Scout could not read.", "This account has no website, so HubSpot cannot match it." and "Something went wrong sending this to HubSpot. Try again."

### CRM-E3-S6 Re-push and push anyway
As a leader, I want to push again after new facts or a reassignment, so that the CRM stays current.
- CRM-E3-S6-AC1 `POST /v1/accounts/{id}:push` (202) and the account page's "Push again" create a new
  handoff that updates the same company, note and tasks. The same call retries a failed handoff. The push uses the latest handoff's assignment and seller; when there is none, or that assignment was declined or withdrawn, it answers 409 "Assign it before pushing."
- CRM-E3-S6-AC2 "Push and keep their owner" pushes the context without changing the owner and records
  `ownership_action = keep`.

### CRM-E3-S7 Undo on decline or withdrawal
As a seller, I want an account I declined to leave my CRM queue, so that my tasks and book stay
accurate.
- CRM-E3-S7-AC1 Given `routing.assignment.declined` or `.withdrawn` for a pushed account, within 10
  seconds the open tasks Scout created are closed with "Declined in Scout: <reason label>" (or "Withdrawn in
  Scout"), and ownership returns to the previous owner recorded on the handoff, or the assigner when
  none was recorded or that owner is inactive. Ownership returns only for an `assign` handoff whose company is still owned by the seller, and covers the company and the people Scout set an owner on. When the assigner has no CRM owner either, the owner stays and the undo records "Owner left as is: <assigner> has no HubSpot owner". A `keep` handoff changes no owner.
- CRM-E3-S7-AC2 A separate short note is added on the company ("Returned by <seller> on <Mon D, YYYY>: <reason label>", or "Withdrawn by <name of whoever withdrew> on <date>"); the context note is never edited by an undo, and the note, people
  and anything a person wrote in the CRM are never deleted.
- CRM-E3-S7-AC3 Tasks a person already completed stay completed. The handoff records what was undone (`undone` = `tasksClosed[]`, `tasksLeftDone[]`, `ownerReturnedTo`, `noteExternalId`, `at`), and the account page lists it. A completed handoff that was undone stays `completed` with `undone` set, and `crm.handoff.cancelled` tells Routing it is no longer in the CRM.
- CRM-E3-S7-AC4 When the decline arrives before the push finished, the push stops after its current
  write and the undo runs on what was written. The decline consumer sets `cancel_requested_at` on the assignment's handoffs in its own transaction and enqueues `crm.handoff.undo`; the push re-reads the flag (committed state) before each CRM write and, on finding it, ends with status `cancelled`. The undo takes the same account lock, so it runs after the push and undoes what the links show was written. A handoff still `queued` becomes `cancelled` with nothing to undo.
