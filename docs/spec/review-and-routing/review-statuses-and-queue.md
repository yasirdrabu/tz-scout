# REV-E1 Review statuses and queue

Release R1 (default statuses, queue), R2 (configurable statuses and reasons)

## Why

Accounts arrive from agents, vendors, partners and lists. Some need a careful look before anyone acts;
some are already trusted. Statuses make that visible, and the queue puts the most promising first.

## Rules

- Default statuses (seeded, editable in R2):

| Key | Label | Counts as reviewed | Declined | Initial for |
|---|---|---|---|---|
| `unvetted` | Unvetted | no | no | agents, vendors, partners |
| `needs_review` | Needs review | no | no | people, CSV imports, CRM leads, forms |
| `reviewed` | Reviewed | yes | no | |
| `declined` | Declined | yes | yes | |

- A tenant can add statuses (for example "Needs more info" with `returns_to_source`), rename, reorder
  and archive them; at least one must count as reviewed and one must be declined. Archived statuses
  keep their history.
- Initial status per source kind, with per-source overrides (for example Yasir's agent starts at
  Needs review).
- **Review is a permission** (`review:act`), not a role, and is limited by data scope: a person
  reviews only accounts they can see.
- "Send back" sets a status with `returns_to_source` and requires a note; Sources and intake shows the
  note to the source (status and webhook) so an agent can fix and resend.
- Declining requires a reason from the tenant's list (defaults: Not a fit, Already a customer, Open
  deal elsewhere, Duplicate, Bad data, Wrong timing, Other with note). Declines feed the source's trust
  (Sources and intake consumes the event).
- A declined account can be reopened to Needs review with a note.

### Queue

- Default view: accounts not yet assigned whose status does not count as reviewed, sorted by priority
  descending, then newest arrival.
- Columns: account, practice, best offer, tier, priority, fit, intent, warm intro, sources, status,
  flags, arrived. Numbers right-aligned.
- Filters: status, practice, offer, source (any level: person, agent, vendor), batch, tier, flag
  (conflicts, enrichment requested, low trust), arrived date.
- Bulk actions: set status, decline with reason, assign (same seller, same template).
- Flags: **conflicts** (two sources disagree), **enrichment requested**, **low trust** (effective
  trust below 0.4).

## Stories

### REV-E1-S1 See the review queue
As a leader, I want a queue of new accounts sorted by priority with flags, so that I spend review time
where it matters.
- REV-E1-S1-AC1 An account resolved from an agent arrival appears in the queue as Unvetted within 5
  seconds of `intake.arrival.resolved`.
- REV-E1-S1-AC2 Every filter above narrows the list; filters are kept in the URL.
- REV-E1-S1-AC3 A seller without `review:act` does not see the queue in navigation, and the API
  returns 403.
- REV-E1-S1-AC4 A reviewer scoped to practice P never sees accounts outside P in the queue or counts.

### REV-E1-S2 Change status with a note
- REV-E1-S2-AC1 Every change records from, to, who, when, note and reason, and publishes
  `routing.status.changed`.
- REV-E1-S2-AC2 Decline without a reason is rejected with "Pick a reason".
- REV-E1-S2-AC3 Send back without a note is rejected with "Say what the source should fix".

### REV-E1-S3 Leader insights
As a leader, I want to add what I know to the account before assigning, so that the AE starts with it.
- REV-E1-S3-AC1 Insights are free text with author and time, shown at the top of the brief for the
  assigned seller and included in the CRM note on handoff.

### REV-E1-S4 Configure statuses and reasons (R2)
As an owner, I want to define our own review statuses and decline reasons, so that the process fits
how we work.
- REV-E1-S4-AC1 Owners can add, rename, reorder and archive statuses and reasons; constraints above
  are enforced with plain messages.
- REV-E1-S4-AC2 Initial status can be set per source kind and per source.
