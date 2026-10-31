# REV-E1 Review statuses and queue

Release R1 (default statuses, queue, and the status and reason editor, Decision 2 in web-ui/api-gaps.md)

## Why

Accounts arrive from agents, vendors, partners and lists. Some need a careful look before anyone acts;
some are already trusted. Statuses make that visible, and the queue puts the most promising first.

## Rules

- Default statuses (seeded in the mockup's words; keys stay as they were):

| Key | Label | Color | Set by | Flag after | Counts as reviewed | Declined | Returns to source | Initial for |
|---|---|---|---|---|---|---|---|---|
| `unvetted` | Ready for review | Plum | Scout | 48 h | no | no | no | agents, vendors, partners |
| `needs_review` | In review (shown "In review by {name}") | Amber | A reviewer | 24 h | no | no | no | people, CSV imports, CRM leads, forms |
| `reviewed` | Approved | Green | A reviewer | Final | yes | no | no | |
| `declined` | Not pursued | Red | A reviewer | Final | yes | yes | no | |
| `sent_back` | Sent back to source | Gray | A reviewer | Final | yes | no | yes | |

- Each status has a name, color, "What it means", "Set by", "Flag after" (hours, never, or final for a
  status that counts as reviewed) and an order. An account in a status longer than "Flag after" is
  late; the editor shows "In it now" and "{n} late".
- A tenant can add statuses, rename, recolor, reorder and archive them (R1 editor:
  `GET/PUT /api/v1/settings/review/statuses`, `/reasons`, `POST /api/v1/settings/review:reset`). The
  statuses Scout needs (the first status, the reviewed, declined and send-back ones) can be renamed and
  recolored but not archived. Archiving another status moves its accounts to the first status.
  Statuses are archived, never deleted, and keep their history. "Waiting on enrichment" comes in R2;
  "In HubSpot" is the handoff state, not a review status.
- Initial status per source kind, with per-source overrides (for example Yasir's agent starts at
  Needs review).
- **Review is a permission** (`review:act`), not a role, and is limited by data scope: a person
  reviews only accounts they can see.
- "Send back" sets a status with `returns_to_source` and requires a send-back reason from the tenant's
  list (defaults: Not our kind of customer, Already a customer, Duplicate of another account, Bad or
  missing contact, Wrong practice). The note is optional, and required only when the reason is marked
  "Note required" (Decision 1). Bulk send back applies one reason and note to each account (up to 50)
  and reports each account's result. A send back keeps the stage, takes the account out of the queue,
  and also works from Not pursued. Sources and intake shows the reason and note to the source (status,
  webhook and feedback) so an agent can fix and resend.
- Not pursued (declining at review) requires a reason from the tenant's list (defaults: Not a fit,
  Already a customer, Open deal elsewhere, Duplicate, Bad data, Wrong timing, Other). Any reason can be
  marked "Note required" (Other is by default). Declines feed the source's trust (Sources and intake
  consumes the event).
- Reasons are one list with `applies_to` (`review`, `assignment`, `both` or `send_back`) and
  `note_required`; the editor shows send-back reasons and AEs' decline reasons as separate lists.
- A declined account can be reopened to In review with a note.
- **Notes** (Decision 3): a list of notes per account (author, date, text, up to 4,000 characters),
  `GET/POST /api/v1/accounts/{id}/notes`, visible to everyone who can see the account; the queue shows
  the count. Leader insights stay as the single block that goes into the CRM note.
- **Best offer** (Decision 5): a reviewer can pick the lead offer from the approved offers
  (`PUT /api/v1/accounts/{id}/lead-offer`, null for Scout's pick). Rows, the offer filter and its counts
  use the pick when set, else Scout's best offer.
- **Tier** (Decision 4): a reviewer can set the tier by hand (`PUT /api/v1/accounts/{id}/tier`, with an
  optional note), shown with who changed it and the tier Scout scored. Scoring keeps it through every
  rescore until someone picks Scout's tier again; the priority number stays Scout's.

### Queue

- Default view: accounts not yet assigned whose status does not count as reviewed, sorted by priority
  descending, then newest arrival.
- Columns: account, best offer, priority, tier, source, review status, flags, notes (default on);
  practice, fit, buying intent, arrived (default off). Each person shows, hides and orders them
  (`/api/v1/me/preferences/review-queue-columns`). Numbers right-aligned. Tier tab and filter option
  counts come from `GET /api/v1/review-queue/facets`.
- Filters: status, practice, offer, source (any level: person, agent, vendor), batch, tier, flag
  (conflicts, enrichment requested, low trust), arrived date.
- Bulk actions: set status, decline or send back with one reason, assign (same seller, same template).
- Flags: **conflicts** (two sources disagree), **enrichment requested**, **low trust** (effective
  trust below 0.4).

## Stories

### REV-E1-S1 See the review queue
As a leader, I want a queue of new accounts sorted by priority with flags, so that I spend review time
where it matters.
- REV-E1-S1-AC1 An account resolved from an agent arrival appears in the queue as Ready for review within 5
  seconds of `intake.arrival.resolved`.
- REV-E1-S1-AC2 Every filter above narrows the list; filters are kept in the URL.
- REV-E1-S1-AC3 A seller without `review:act` does not see the queue in navigation, and the API
  returns 403.
- REV-E1-S1-AC4 A reviewer scoped to practice P never sees accounts outside P in the queue or counts.

### REV-E1-S2 Change status with a note
- REV-E1-S2-AC1 Every change records from, to, who, when, note and reason, and publishes
  `routing.status.changed`.
- REV-E1-S2-AC2 Decline without a reason is rejected with "Pick a reason".
- REV-E1-S2-AC3 Send back without a send-back reason is rejected with "Pick a reason"; with a reason
  marked "Note required" and no note it is rejected with "Say what the source should fix." (Decision 1).

### REV-E1-S3 Leader insights
As a leader, I want to add what I know to the account before assigning, so that the AE starts with it.
- REV-E1-S3-AC1 Insights are free text with author and time, shown at the top of the brief for the
  assigned seller and included in the CRM note on handoff.

### REV-E1-S4 Configure statuses and reasons (R1, Decision 2)
As an owner, I want to define our own review statuses and decline reasons, so that the process fits
how we work.
- REV-E1-S4-AC1 Owners can add, rename, reorder and archive statuses and reasons; constraints above
  are enforced with plain messages.
- REV-E1-S4-AC2 Initial status can be set per source kind and per source.
