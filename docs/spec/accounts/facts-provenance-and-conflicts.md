# ACC-E3 Facts, provenance and conflicts

Status: Draft · Release: R1 (facts and current values), R2 (conflicts UI and resolution)

## Why

Two sources will disagree: an ABM sheet says the incumbent contract is $20.9M, an agent says $18.4M.
Scout keeps both with where each came from, shows the disagreement, and lets a person keep one and
archive the other (D4). The losing source hears about it and loses a little trust.

## Rules

### Facts

- Every value about an account or person is a **fact** row: key, value, type, kind, source chain,
  arrival, URL, note, `observed_at` (when the source says it was true; defaults to the arrival time)
  and `recorded_at`.
- The ABM researcher's tier (`researcher_tier`, A, B or C) is projected onto the account as
  `research_tier`, with `research_tier_signal_at` set to the date of the newest signal that arrived in
  the same arrival (none if the arrival had no dated signal). SCO uses them as a tier floor.
- Fact keys: every account and person field in ACC-E1, research keys (`hook`, `problem`, `pilot`,
  `price_cents`, `value_hypothesis`, `incumbent`, `caveats`, `contact_route`, `next_action`,
  `researcher_score`, `researcher_tier`), common money facts (`contract_value_cents`,
  `budget_cents`), form answers (`form.<name>`), and custom field keys (ACC-E6).
- List facts (`technologies`, `keywords`) merge: the current value is the union of current list facts.
- Free-text facts (`description`, research text) never conflict; the newest is current and earlier
  ones are kept as history.

### Picking the current value

For each key, in order:
1. A fact **pinned** by a person (an edit, or the kept value of a resolved conflict).
2. Otherwise the fact from the source with the highest effective trust (read through
   `SourceInfoProvider.getTrust`, implemented by SRC), then the most recent
   `observed_at`.
3. A newer fact from the **same** source supersedes that source's older fact (status `superseded`),
   never a conflict.

The account and person tables hold the current values (projection); they are rebuilt from facts when
pins, trust or facts change.

### Conflicts

A conflict opens when a new fact from a **different** source differs from the current value beyond
the key's tolerance:

| Value type | Tolerance (default, editable per key in Settings) |
|---|---|
| Count (`employees`) | differs by more than 20% |
| Money (`revenue_cents`, `contract_value_cents`) | more than 25% for revenue, 10% for other money |
| Range (`employees_range`) | ranges don't overlap |
| Category (`industry_key`, `hq_country`, select custom fields) | different value |
| Email, phone, title | different value after normalising |
| Free text, lists | never |

- While open, the current value follows the picking rule and the page marks it "Sources disagree".
- AI task `conflict_explanation` adds one line on why the values may differ ("The $20.9M figure includes
  the PASS modules; the $18.4M figure is the base contract"), citing the fact ids it used. It never
  picks a winner.
- Resolving: a person with `review:act` keeps one fact (API keys can't resolve conflicts, even with
  that scope). The kept fact is pinned; the others are
  `archived`. A note is optional.
- `accounts.conflict.resolved` carries the winning and losing source ids; SRC records feedback to the
  losing sources and lowers their trust by 0.01 (SRC-E1).
- A later fact that agrees with the kept value closes nothing new; one that differs opens a new
  conflict against the pinned value.

## Stories

### ACC-E3-S1 Every value has a source
As a leader, I want to see where any value came from, so that I can judge it.
- ACC-E3-S1-AC1 Hovering or tapping any account or person value shows source chain, date observed,
  link and arrival; "History" lists every fact for that key.
- ACC-E3-S1-AC2 `GET /api/v1/accounts/{id}/facts?include=history` returns the same.

### ACC-E3-S2 Current value rules
As the system, I want one deterministic rule for which value is shown, so that the same facts always
give the same account.
- ACC-E3-S2-AC1 Unit tests: pinned beats trust; higher trust beats newer; same source newer supersedes;
  list facts union; free text newest.
- ACC-E3-S2-AC2 A trust change re-picks affected current values without opening conflicts.

### ACC-E3-S3 Spot disagreements
As a leader, I want Scout to flag when sources disagree, so that I don't act on a wrong number.
- ACC-E3-S3-AC1 Unit tests for each tolerance in the table, including "3,000 vs 3,500 employees" (no
  conflict) and "$20.9M vs $18.4M contract value" (conflict).
- ACC-E3-S3-AC2 Detection publishes `accounts.conflict.detected`; the account page shows both values
  side by side with source, date and trust, and buttons "Keep $20.9M" and "Keep $18.4M".

### ACC-E3-S4 Resolve a conflict
As a leader, I want to keep one value and archive the other, so that the account is right and the
source learns.
- ACC-E3-S4-AC1 Keeping a value pins it, archives the others, closes the conflict, and publishes
  `accounts.conflict.resolved` with losing sources.
- ACC-E3-S4-AC2 The audit log shows who resolved it and the note.
- ACC-E3-S4-AC3 `POST /api/v1/conflicts/{id}:resolve` from an API key or OAuth grant returns `403` with
  "Only a person can settle a disagreement between sources."
