# REV-E2 Assignment, acceptance and decline

Release R1

## Why

The leader conducts: picks the seller, adds notes, and hands over. The seller can say no, with a
reason, and the reason is tracked so leaders see why accounts bounce.

## Rules

- Assigning requires `assign:act` and data scope over the account. The account's status must count
  as reviewed; assigning from Unvetted or Needs review sets it to the tenant's first "counts as
  reviewed" status in the same action (one click: "Approve and assign").
- Assignment fields: seller (members with the seller capability), notes, playbook template (optional,
  passed through; **R2**, absent in R1 where `templateId` is always null, D27), lead offer (defaults to
  best offer; an override is stored on `account_review`).
- One open assignment per account. Assigning again replaces the open one (`replaced`) and notifies the
  previous seller.
- **Acceptance.** The seller accepts in Scout, or acceptance is implied when:
  - the seller completes a CRM task or logs an email, call or meeting on the account after the
    handoff (`crm.activity.observed` by that seller): `accepted_how = crm_activity`; or
  - 2 working days pass with no decline: `accepted_how = auto_timeout` (configurable 1 to 10 days,
    or off).
  AEs mostly work in the CRM, so implicit acceptance keeps the funnel moving without forcing them into
  Scout.
- **Decline.** The seller declines with a reason (tenant list with `applies_to` assignment; defaults:
  Not my territory, Too much on my plate, Already talking to them, Not a fit, Other with note). The
  account returns to the assigner with status unchanged, stage back to `reviewed`, and the decline
  shows on the queue as a flag "Declined by Mike: Not my territory". CRM sync undoes the handoff
  (REV-E3).
- Withdraw: the assigner (or an owner) can withdraw an open assignment, optionally reassigning.

## Stories

### REV-E2-S1 Approve and assign
As a leader, I want to approve and assign in one step with notes and a playbook, so that a reviewed
account reaches an AE in seconds.
- REV-E2-S1-AC1 From the account page or the queue, Approve and assign opens a dialog with seller,
  lead offer and notes (plus playbook from R2); submitting creates the assignment and publishes
  `routing.assignment.created`.
- REV-E2-S1-AC2 The ownership preflight (REV-E3) runs before submit; if it says stop, the dialog shows
  why and offers "Push anyway, keep their owner" or cancel.
- REV-E2-S1-AC3 Bulk assign applies the same seller (and, from R2, playbook) to up to 50 selected accounts and
  reports each result.

### REV-E2-S2 Seller accepts
- REV-E2-S2-AC1 The seller gets an in-app notification and the account in "My accounts" with Accept
  and Decline.
- REV-E2-S2-AC2 A CRM task completed by the seller on the account after handoff accepts the assignment
  with `accepted_how = crm_activity`. In R1 this happens on the next 15-minute activity poll
  (CRM-E5, D32).
- REV-E2-S2-AC3 With the default 2 working days and no response, the assignment is accepted with
  `auto_timeout`; the leader can see how each assignment was accepted.

### REV-E2-S3 Seller declines with a reason
As an AE, I want to decline an account with a reason, so that it goes back to the leader instead of
rotting in my list.
- REV-E2-S3-AC1 Decline requires a reason; "Other" requires a note.
- REV-E2-S3-AC2 After decline, the account is back in the leader's queue with the flag and the
  reason, stage `reviewed`, and `routing.assignment.declined` is published.
- REV-E2-S3-AC3 Decline reasons are reportable by seller, practice, source and reason (Analytics).

### REV-E2-S4 Reassign and withdraw
- REV-E2-S4-AC1 Reassigning replaces the open assignment, notifies both sellers and publishes
  `routing.assignment.withdrawn` then `routing.assignment.created`.
