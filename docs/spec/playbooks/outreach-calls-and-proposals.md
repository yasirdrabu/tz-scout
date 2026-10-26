# PLB-E5 Outreach, calls and proposals

Release R2 · Carried from v1 (`src/ai/outreachSequence.ts`, `callPrep.ts`, `callReview.ts`,
`proposal.ts`)

## Why

AEs need the words as well as the plan: the first emails, a discovery plan, a scored call review and
a proposal draft, all grounded in the account and offer.

## Rules (carried)

- **Follow-up sequence:** 4 emails per account and person: day 0 opener, day 3 new angle, day 7
  proof, day 14 close the loop. Signed by the owner. Never quotes research intent, lawsuits or
  breaches. Each email can become a dated CRM task on handoff (CRM sync) and is listed in the CRM
  note.
- **First person to approach** (`pickPrimary`, carried): a title the offer targets, then a buying
  role the offer targets, then seniority, then a verified email.
- **Call prep:** a discovery plan per account (questions from winning statements when Campaigns has
  them, the offer's proof, the why-now signals).
- **Call review:** paste a transcript or a Fathom recap; scored on the 7-item qualification checklist,
  with pains in the buyer's words, next steps, coaching, and a follow-up email; can be added to the
  CRM as a note.
- **Proposal:** drafted from the account, offer and reviewed calls; editable; copy as text; add to the
  CRM. Never quotes internal research.
- All are AI tasks with rules fallbacks, labelled honestly.

## Stories

### PLB-E5-S1 Follow-up sequence
- PLB-E5-S1-AC1 The account page shows the sequence for the primary person, editable per email.
- PLB-E5-S1-AC2 Email steps in the account plan of type email link to the matching sequence email.

### PLB-E5-S2 Call prep and review
- PLB-E5-S2-AC1 "Prepare for a call" produces a plan in under 60 seconds (AI) with questions,
  proof and watch-outs.
- PLB-E5-S2-AC2 A pasted transcript is scored on the 7 items, each with evidence quotes, and records a
  `meeting` outcome if none exists for that date.

### PLB-E5-S3 Proposals
- PLB-E5-S3-AC1 A proposal draft opens in an editable page; "Copy as text" and "Add to CRM" work.
