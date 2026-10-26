# REV-E3 Ownership and handoff trigger

Release R1 · Ownership rule carried from `src/lib/ownership.ts` (decided 2026-10-16)

## Decision: the handoff starts on assignment, and a decline undoes it

The CRM push starts when the assignment is created, not when the seller accepts. AEs work in the CRM;
waiting for them to accept in Scout would delay the account and the first touch. Target: the account,
people, note and tasks are in the CRM within 10 seconds of assignment (p95).

If the seller declines or the assignment is withdrawn, CRM sync undoes what it can: open tasks it
created are closed with "Declined in Scout: <reason>", ownership returns to the previous owner it
recorded (or the assigner), and the note stays with a line added. Data in the CRM written by people is
never deleted.

## Ownership rule (owned and executed by CRM sync; REV shows the preflight)

When an account already exists in the CRM with another owner:

| Situation | Result |
|---|---|
| Not in CRM, no owner, or owned by our seller | assign to our seller |
| Owned by the owner we set on an earlier push | assign (we set it last time) |
| Open deal, or the company is an existing customer | **stop**: never taken over; "Push anyway, keep their owner" adds the context and leaves ownership |
| Owner inactive (left the company) | assign, record who had it |
| Another active owner, and the tenant setting "take over stale ownership" is on (default on) | assign, record who had it |
| Another active owner, setting off | stop; "Push anyway, keep their owner" available |

## Stories

The seller's CRM owner id comes from their membership (`crmOwnerId(ctx, userId, crm)` in Tenancy and
access). If the seller has none for the tenant's CRM, the preflight says "Ash has no HubSpot owner
set. Set it in Members first." and assignment is blocked.

### REV-E3-S1 Preflight before assigning
As a leader, I want to know before I assign whether the CRM already has an owner, an open deal or a
customer record, so that I don't step on a colleague's deal.
- REV-E3-S1-AC1 The assign dialog calls `preflightOwnership` and shows one of: "New in the CRM",
  "Owned by Rahul (inactive): will move to Ash", "Open deal owned by Vijay: will not change owner".
- REV-E3-S1-AC2 A stop result disables plain assign and offers "Push anyway, keep their owner"; the
  choice is stored on the assignment (`ownershipDecision`).

### REV-E3-S2 Handoff starts on assignment
- REV-E3-S2-AC1 `routing.assignment.created` is consumed by CRM sync; the stage tracker shows "Sending
  to CRM" until `crm.handoff.completed`, then "In CRM".
- REV-E3-S2-AC2 A failed handoff shows on the account and notifies the assigner with the error and
  "Try again".

### REV-E3-S3 Decline undoes the handoff
- REV-E3-S3-AC1 After a decline, CRM sync closes the tasks it created and restores the previous owner
  within 10 seconds; the account page shows what was undone.
