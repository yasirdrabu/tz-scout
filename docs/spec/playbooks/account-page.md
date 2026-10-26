# PLB-E4 Account page (layout A)

Release R1 (review view), R2 (full layout)

## Why

The account page is where a leader decides and an AE prepares. Layout A was chosen: a brief read top
to bottom, then act. It changes emphasis with the account's stage.

## Layout

The page composes data from several modules through their public interfaces; Playbooks owns the page.

1. **Header.** Account name and short descriptor (for example "Special Transportation Service"),
   location, account type (public agency, private company), practice, best offer. Pills: review status,
   tier, motion (from custom field or template), each source that sent it (with "+ n more"). Actions on
   the right (see "Stage-dependent behaviour").
2. **Score strip.** Priority, fit, buying intent, revenue potential, source trust, then custom fields
   marked for the strip (for example fleet tier). Each opens the score explanation (SCO-E4).
3. **Two columns** (one column under 900px wide):
   - Left: Overview, What they do, Potential size, Why now (dated timeline: date, signal, source),
     Account facts (with conflicts shown inline: both values, their sources, "Keep this one"), Risks.
   - Right: Buying committee (person, title, buying role pill, email quality, entry point note; gaps
     for the offer's `target_buying_roles` with "Find"), Possible approach, Our value angle, Playbook
     (the plan's steps as a checklist with week, owner, due, status), Activity and outcomes.
4. **Footer.** Sources and data dates, "Other offers that fit", score history link.

All numbers right-aligned with tabular figures; status colours only for meaning (overdue amber,
conflicts amber, gaps red only when the offer requires that role).

## Stage-dependent behaviour

| Stage | Header actions | Leads with |
|---|---|---|
| Arrived, not reviewed (Unvetted, Needs review) | Enrich, Send back, Decline, **Approve and assign** | Score strip, Why now, conflicts and gaps called out at the top ("2 sources disagree", "No IT contact") |
| Reviewed, not assigned | Assign (primary), Enrich, Decline | Same, plus the suggested playbook preview |
| Assigned, awaiting seller | Reassign, Withdraw | Assignment note and the plan |
| In CRM / engaged / opportunity | Open in CRM, Log outcome, Edit plan | Playbook progress (done, due, overdue), Activity and outcomes, then the brief |
| Won or lost | Write retro (primary) | Outcome summary, retro, learnings |

Buttons whose permission the viewer lacks are hidden. A seller sees only accounts in their data scope.

## Stories

### PLB-E4-S1 Review view (R1)
As a leader, I want one page with the brief, scores and the decision buttons, so that I can review an
account in under two minutes.

R1 scope (spec's call, D27): the review view in layout A **without** the conflicts box, the Enrich
button, committee gaps and the playbook section or preview. Those depend on ACC-E3 conflicts, ENR
requests, ACC-E2 committee coverage and PLB plans, all R2. Leaders review and assign from this page in
R1; the assign dialog has no playbook picker until R2.

- PLB-E4-S1-AC1 For an Unvetted account, the page shows header, score strip, why now, people with
  their buying roles, account facts (current values with their source), and Approve and assign, Send
  back, Decline.
- PLB-E4-S1-AC2 (R2) Conflicts and committee gaps appear in a callout above the brief when present,
  and the Enrich button is shown to principals with `enrichment:request`.
- PLB-E4-S1-AC3 The page loads in under 1.5 seconds at p95 with 20 signals and 15 people.

### PLB-E4-S2 Working view (R2)
As an AE, I want the page to lead with my plan and what has happened, so that I prepare for the next
touch fast.
- PLB-E4-S2-AC1 Once assigned, the plan and activity move above the brief; overdue steps are amber.
- PLB-E4-S2-AC2 "Open in CRM" links to the account's CRM record (from CRM sync).
- PLB-E4-S2-AC3 Log outcome records a reply, meeting, opportunity, won or lost with an optional
  amount and note.

### PLB-E4-S3 Printable one-pager
- PLB-E4-S3-AC1 "Print brief" produces a one-page layout like the Miami-Dade example: header, score
  strip, two columns of sections, with no app chrome.
