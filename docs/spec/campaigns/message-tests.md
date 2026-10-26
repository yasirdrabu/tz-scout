# CMP-E1 Message tests

Release R4 · Module CMP · Carried from v1 Module 3

## Why

Before spending on campaigns, find which problem and outcome statements a segment's buyers respond to.
Winners become ad copy, landing page headlines, discovery questions and playbook openers.

## Rules (carried)

- For an active segment, Claude writes 12 to 15 statements: half problems, half outcomes, in the
  buyer's words, under 25 words, no product names.
- A message test is a set of statements launched together, each as its own ad set.
- Settings: budget (default $300), duration (default 72 hours), channel (Meta first; LinkedIn optional),
  target clickthrough rate and target cost per click.
- Statuses: draft → approved (by an owner) → running → complete.
- Verdict per statement (pure function, unit tested): **pass** when clickthrough rate ≥ target AND cost
  per click ≤ target; **fail** otherwise; **not enough data** under 1,000 impressions (configurable).
- Actions per statement: keep, drop, rewrite (Claude suggests one from the winners), retest.
- Winners go to a statement library per segment; exportable as ad copy, landing page headlines and
  discovery call questions.

## Stories

### CMP-E1-S1 Generate and edit statements
As an operator, I want Claude to draft statements for a segment that I can edit, so that tests start
from the buyer's words.
- CMP-E1-S1-AC1 Generating gives 12 to 15 statements, balanced problem and outcome, each under 25 words
  and without the tenant's product names (validated; failing items are regenerated).
- CMP-E1-S1-AC2 Operators can add, edit, remove and re-classify statements while the test is a draft.

### CMP-E1-S2 Approve and launch
As an owner, I want to approve the budget before launch, so that spend is controlled.
- CMP-E1-S2-AC1 Only owners can approve; launch is blocked until approved.
- CMP-E1-S2-AC2 Launch creates one ad set per statement through the ad channel adapter; with the mock,
  realistic random results arrive after a simulated delay.

### CMP-E1-S3 Verdicts and decisions
As an operator, I want pass or fail per statement, so that I know what to keep.
- CMP-E1-S3-AC1 The verdict function matches the rule above, with tests at the boundaries (exactly at
  target, 999 and 1,000 impressions).
- CMP-E1-S3-AC2 Results show impressions, clicks, clickthrough rate, cost per click and spend, with
  pass, fail or "Not enough data" chips.
- CMP-E1-S3-AC3 Rewrite creates a new statement linked to the original; retest puts it in a new draft
  test.

### CMP-E1-S4 Statement library
As a leader, I want all winners per segment in one place, so that playbooks and openers use proven
words.
- CMP-E1-S4-AC1 The library lists every kept statement per segment across tests, with its numbers.
- CMP-E1-S4-AC2 Export gives ad copy, landing page headlines and discovery questions as text and CSV.
- CMP-E1-S4-AC3 Playbooks can read a segment's winners through the public interface for brief drafting.
