# ANL-E4 Flywheel trends

Release R3 · Module ANL

## Why

The flywheel is: sources send accounts → accounts are won or lost → retros produce learnings →
playbooks and source trust get better → better accounts and higher win rates. Leaders need to see
whether it is turning, as trend numbers first (decision in README), with a diagram on the overview.

## Trend numbers (by quarter, last 4 quarters, plus this quarter to date)

| Number | Meaning |
|---|---|
| Cost per won client | overall and per source level |
| Win rate | overall and per source |
| Median days from arrival to won | speed of the funnel |
| Share of arrivals declined at review | quality of what comes in |
| Average source trust (weighted by arrivals) | are we getting better sources |
| Learnings recorded and template edits accepted | is the retro loop working |
| Engaged rate of accounts on an account plan vs not | do playbooks help |
| Outcomes credited per step type and per playbook | what worked: replies, meetings, opportunities and wins credited to steps (`playbooks.outcome.recorded` `creditedStepIds`), per 10 steps done |

## What worked roll-up

From `analytics.step_credit`: for each playbook template and each step type (email, call, event,
procurement, research and the rest), count outcomes credited by kind, and divide by steps of that
type completed in the period. Shown as a table under the trend numbers, filterable by practice and
offer. A step credited for several outcomes counts once per outcome. The per-template view in
Playbooks (PLB template stats) reads the same numbers through this module's public interface
`whatWorked(ctx, filter)`.

## Stories

### ANL-E4-S1 Flywheel overview
As a CRO, I want one page with the flywheel numbers by quarter, so that I can tell in a minute whether
we're improving.
- ANL-E4-S1-AC1 The page shows each number above for the last four quarters and quarter to date, with
  the change from the previous quarter.
- ANL-E4-S1-AC2 A change is green when it moved the right way by more than 5%, red when it moved the wrong
  way by more than 5%, otherwise neutral; below the minimum sample it is grey.
- ANL-E4-S1-AC3 A simple diagram of the loop sits at the top, each step labelled with its current number.

### ANL-E4-S3 What worked by step
As a leader, I want to see which kinds of steps lead to replies, meetings and wins, so that playbooks
keep the steps that work.
- ANL-E4-S3-AC1 The table shows, per playbook and step type, steps done and outcomes credited by kind,
  with outcomes per 10 steps; values below the minimum sample are grey.
- ANL-E4-S3-AC2 Given scripted outcomes with credited steps, the counts match a hand count.
- ANL-E4-S3-AC3 Replaying the same `playbooks.outcome.recorded` adds no credit rows.

### ANL-E4-S2 What changed
As an owner, I want the biggest movers listed, so that I know where to look.
- ANL-E4-S2-AC1 Under the numbers, the three sources and three playbooks with the largest change in win
  rate this quarter are listed with links.
