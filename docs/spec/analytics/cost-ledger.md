# ANL-E2 Cost ledger

Release R3 · Module ANL

## Why

"What did a won client cost" needs every cost in one ledger, collected automatically where possible
(decision D16), with people adding what systems can't see.

## Cost lines

| Category | Origin | Comes from | Target |
|---|---|---|---|
| Vendor credits (Apollo, Vibe, company data) | auto | `integrations.usage.recorded` for the provider (every costed call goes through Integrations' `gateway.call`) | the account of the matching enrichment request (`enr_…`, same `correlationId`), else the event's `sourceId` (a scheduled pull), else none |
| AI | auto | `integrations.usage.recorded` for `anthropic` (tokens × model price) | the account of the matching AI run (same `correlationId`), else none |
| Integration usage (other paid APIs) | auto | `integrations.usage.recorded` | the event's `sourceId`, else none |
| Ad spend | auto | `campaigns.ad_spend.recorded` (daily per channel, as the channel reports it) | the ad source |
| Hours | manual | a person logs hours × the role's hour rate | source, batch, account, practice or none |
| Event | manual | tickets, travel, sponsorship | practice, offer or account |
| Referral fee | manual | partner fees | the partner's source or the account |
| Other | manual | anything else, with a note | any target |

Rules:

- Amounts in integer cents with the tenant's currency.
- Lines are never edited. A wrong line is voided with a reason and a new one added; both stay visible
  to owners.
- Auto lines carry `origin_event_id`, so replaying an event never creates a second line.
- One costed outside call = one `integrations.usage.recorded` = one line. `enrichment.request.completed`
  and `ai.run.completed` never create lines; they only tell Analytics which account a usage record
  with the same `correlationId` belongs to. If the usage record is processed first, its line is
  created with target none and re-targeted when the matching event arrives (an internal update before
  the line is shown, not an edit of a visible line).
- Prices for credits and tokens are set in Integrations; a usage record with no price records the
  quantity with a zero amount and flags "Price not set".

## Allocation

To get cost per account and per source, lines are spread to accounts (pure function
`allocate(lines, journeys)`):

| Target | Spread over |
|---|---|
| account | that account |
| batch | the batch's resolved arrivals, evenly |
| source | the source's resolved arrivals in the line's period, evenly |
| practice or offer | accounts attributed to it that arrived in the period, evenly |
| none | not spread; shown as "Shared costs" and included in totals only |

## Stories

### ANL-E2-S1 Automatic cost lines
As an owner, I want vendor, AI and ad costs recorded without anyone typing them, so that costs are
complete.
- ANL-E2-S1-AC1 Each auto category above creates exactly one line per origin event, even when the
  event is delivered twice.
- ANL-E2-S1-AC3 An Apollo enrichment that produces `integrations.usage.recorded` and
  `enrichment.request.completed` results in one line, targeted at the enriched account, whatever order
  the two events arrive in.
- ANL-E2-S1-AC2 A line shows its origin (for example "Apollo enrichment, 3 credits, Acme Corp").

### ANL-E2-S2 Manual cost lines
As a leader, I want to add hours, event costs and referral fees, so that the cost picture includes
people's time and spend outside systems.
- ANL-E2-S2-AC1 The add form takes category, amount (typed in dollars, stored in cents) or hours plus
  role, date or period, target and note.
- ANL-E2-S2-AC2 Owners and leaders can add; sellers can log their own hours against their own
  accounts only.
- ANL-E2-S2-AC3 Voiding needs a reason and is shown in the ledger with who and when.

### ANL-E2-S3 Ledger view
As an owner, I want one ledger with totals, so that I can check what's in the numbers.
- ANL-E2-S3-AC1 The ledger lists lines with filters (category, origin, target, period) and shows totals
  by category and by target.
- ANL-E2-S3-AC2 Given test lines and journeys, `allocate` gives hand-calculated per-account amounts, and
  the sum of allocated plus shared equals the ledger total.
