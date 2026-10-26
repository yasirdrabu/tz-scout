# OFF-E4 Signal rules per offer

Release R1 · Carried from `src/lib/signalRules.ts`

## Why

Each offer has its own reasons to buy now. A new COO matters for the AI Opportunity Map; a legacy
stack matters for the Modernization Blueprint. Rules say which signals count, how much, and why, in
words a rep can use.

## Rules

- A rule: type, label, points (0 to 100), keywords (empty means any signal of that type), optional
  minimum value (a decimal, for example 0.6 for research score or 0.1 for headcount growth), a "why it
  matters" sentence, enabled flag.
- Seeded defaults per offer from `DEFAULT_SIGNAL_RULES`; offers without defaults get the generic set
  (`GENERIC_SIGNAL_RULES`).
- How rules turn into points is defined in SCO-E1; this epic only owns the rules.

## Stories

### OFF-E4-S1 Edit an offer's signal rules
As an operator, I want to add, edit, disable and reorder signal rules for an offer, so that Scout
reflects what we know about when buyers buy.
- OFF-E4-S1-AC0 Editing rules needs `scoring:manage`.
- OFF-E4-S1-AC1 The rules editor lists each rule with type, label, points, keywords, minimum and why;
  every field is editable inline.
- OFF-E4-S1-AC2 Saving publishes `offers.offer.changed` with `affectsMatching: true`; the page shows
  "Rescoring" until Scoring finishes.
- OFF-E4-S1-AC3 "Reset to defaults" restores the seeded set after confirmation built into the page.
- OFF-E4-S1-AC4 A rule's "why" is required; it is shown in explanations and briefs.

### OFF-E4-S2 Signal guide
- OFF-E4-S2-AC1 A guide page explains each signal type in plain words (what it is, how to read it),
  carried from `SIGNAL_EXPLAINER`.

### OFF-E4-S3 Rules suggested by wins (R3)
- OFF-E4-S3-AC1 Rules suggested by win analysis (OFF-E6) appear with "Suggested from wins" and an
  "Add" button; adding sets `origin` to `win_analysis`.
