# PLB-E1 Playbook templates

Release R2

## Why

ABM works when the same motion is run deliberately and improved. A template captures how a practice
or offer is sold: the plays, in what week, through which channel, to which buying role, and the
guidance a rep needs. The Miami-Dade DTPW one-pager is an example of a "public sector RFP" motion:
register as a vendor, brief the business owner, request an industry day via the contracts manager,
show up at the state conference, team with the operator.

## Rules

- A template belongs to a practice (`scope: practice`) or an offer (`scope: offer`). When a plan is
  created, the offer's template is suggested first, then the practice's default, then any active
  template in the practice.
- A template has a motion: one-to-one (Tier 1 named accounts), one-to-few, one-to-many.
- Editing an active template creates a new version. Plans keep the version they were created from;
  the plan shows "A newer version of this playbook exists" with a link to compare.
- Step types: email, call, LinkedIn, event, procurement, research, content, meeting, other. Types are
  what "what worked" is measured by (PLB-E6).
- Each step: week offset, title, guidance (markdown, may use placeholders like `{account.name}`,
  `{person.business_owner.name}`, `{offer.promise}`), owner role, target buying roles, whether it
  becomes a CRM task.

## Stories

### PLB-E1-S1 Create and edit templates
As a leader, I want to build playbooks per practice and offer, so that every account in that motion
starts from what we know works.
- PLB-E1-S1-AC1 A leader or owner can create a template with name, scope, motion, when to use, and
  ordered steps with every field above.
- PLB-E1-S1-AC2 Steps can be added, removed, reordered and duplicated; week offsets need not be
  unique.
- PLB-E1-S1-AC3 Saving an active template with step changes increments `version`; old versions remain
  readable.
- PLB-E1-S1-AC4 Archiving a template stops it being suggested; existing plans are untouched.

### PLB-E1-S2 Seed templates
- PLB-E1-S2-AC1 Seed data gives each Taazaa practice one template, including "Public sector RFP"
  under AI Operating Platforms built from the Miami-Dade example's touch points: week 1 register as
  county vendor and set alerts (procurement, seller); weeks 1 to 2 capability brief to the business
  owner (email, seller, business owner); week 3 request industry day via contracts (procurement,
  seller, commercial buyer); week 4 and on, conference presence and operator teaming (event, leader).

### PLB-E1-S3 Template performance
- PLB-E1-S3-AC1 The template page shows plans run, outcomes reached (reply, meeting, opportunity, won
  counts), median days to first meeting, and per step type the outcomes credited (from PLB-E6). R3.
