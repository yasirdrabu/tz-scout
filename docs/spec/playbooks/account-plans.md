# PLB-E2 Account plans

Release R2

## Why

The leader is the conductor: they review the account, pick the motion, tailor it to what they know,
and hand it to an AE. The AE runs it, mostly from the CRM. Scout keeps the plan, the steps and their
state, so progress is visible without asking.

## Rules

- A plan is created when an assignment is created (`routing.assignment.created` carries the chosen
  `templateId`; default as in PLB-E1). Start date = assignment date. Step due dates = start + week
  offset × 7 days, moved to the next working day.
- Step owners: `seller` steps go to the assigned seller, `leader` steps to the assigning leader,
  `operator` steps unassigned until someone takes them.
- Steps targeting a buying role are linked to the people in that role; if nobody holds the role, the
  step shows "No <role> on file" and a "Find" action (Enrichment).
- Customising a plan (add, remove, edit a step) marks it `customised` and publishes
  `playbooks.plan.changed`; CRM sync updates or closes the CRM tasks in place.
- A step done in the CRM (task completed) is marked done here by `crm.activity.observed`. A step
  done in Scout publishes `playbooks.step.completed` and CRM sync completes the CRM task.
- Decline of the assignment pauses the plan; reassignment resumes it with the new seller as owner of
  seller steps.

## Stories

### PLB-E2-S1 Apply a playbook at assignment
As a leader, I want the plan built when I assign, so that the AE starts with clear steps.
- PLB-E2-S1-AC1 The assign dialog (Review and routing) shows the suggested template and lets the
  leader pick another or "No playbook".
- PLB-E2-S1-AC2 On assignment, the plan exists within 2 seconds with every template step, owners and
  due dates set, and `playbooks.plan.created` is published.
- PLB-E2-S1-AC3 Applying the same template twice to one account is prevented; a second plan requires
  the first to be completed or abandoned.

### PLB-E2-S2 Customise a plan
As a leader, I want to add, remove and edit steps for one account, so that the plan fits what I know
about it.
- PLB-E2-S2-AC1 Each change records who and when and shows on the plan's history.
- PLB-E2-S2-AC2 Changes appear in the CRM tasks within seconds of saving (via CRM sync).
- PLB-E2-S2-AC3 Removing a step that is done is not allowed; it can be marked skipped instead.

### PLB-E2-S3 Run a plan
As an AE, I want to see and tick off my steps with notes, so that the leader sees progress without
asking.
- PLB-E2-S3-AC1 A step can move todo → in progress → done or skipped, with an optional note.
- PLB-E2-S3-AC2 Overdue steps (due date passed, not done) show as amber in the plan and count on the
  leader's queue.
- PLB-E2-S3-AC3 A plan whose steps are all done or skipped can be completed; a plan can be paused or
  abandoned with a reason.
