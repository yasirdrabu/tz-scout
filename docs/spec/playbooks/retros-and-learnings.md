# PLB-E7 Retros and learnings

Release R3

## Why

Each won, lost or stalled account teaches something. Writing it down, and letting it change the
playbook, is how the flywheel turns.

## Rules

- A retro is prompted when an account is won or lost, and when a plan is completed or abandoned
  without an opportunity ("stalled"). It is assigned to the seller with the leader copied.
- Fields: result, what worked, what didn't, key learnings (one per line), and optional proposed
  template edits (add, remove or edit a step, with a reason).
- Claude can draft the retro from the plan, outcomes, call reviews and CRM activity (`retro_summary` task);
  a person edits and submits.
- Proposed edits go to the template's owner (any leader for practice templates) as
  `template_edit_proposal`; accepting one applies it as a new template version and links back to the
  retro.

## Stories

### PLB-E7-S1 Write a retro
As an AE, I want a drafted retro I can correct, so that capturing learnings takes five minutes.
- PLB-E7-S1-AC1 Won or lost creates a retro task for the seller; the account page leads with "Write
  retro".
- PLB-E7-S1-AC2 Submitting publishes `playbooks.learning.recorded`.
- PLB-E7-S1-AC3 Retros are searchable by practice, offer, result and learning text.

### PLB-E7-S2 Learnings change templates
As a leader, I want proposed playbook changes from retros in one place, so that I can accept what
holds up.
- PLB-E7-S2-AC1 The template page lists open proposals with the retro, account and result.
- PLB-E7-S2-AC2 Accept creates a new template version with the change; Reject needs a reason; both are
  audited.
