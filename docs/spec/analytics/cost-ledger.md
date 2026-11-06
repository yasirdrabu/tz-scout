# ANL-E2 Cost ledger

Release R3 · Module ANL

## Why

"What did a won client cost" needs every cost in one ledger, collected automatically where possible
(decision D16), with people adding what systems can't see.

## Cost lines

R3a stores five categories (Ruling 4 of the R3a plan): `partner_fees` "Partner fees", `data_vendors`
"Data vendors", `agents_hosting` "Agents and hosting", `lists_events` "Lists and events" and `ai_usage`
"AI usage". Usage lines land in the provider's category (`anthropic` in AI usage, `apollo` and `vibe` in
Data vendors). Manual lines can go in any category. The table below is the fuller picture R3b and R4
map onto these.

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
- Lines are never edited in place. A wrong line is voided with a reason and a new one added; both stay
  visible to owners. Editing a manual line does this in one step: the old line is voided "Edited" and the
  new one carries `replaces_id`. Usage lines can only be voided.
- A line's date (`occurred_on`) is the tenant-timezone date; a usage line takes the date of the call.
  A manual line (added or edited) can't be dated after today in the tenant timezone: 400 at
  `occurred_on` "A cost can't be dated in the future."
  Spend leaves out voided lines.
- Auto lines carry `origin_event_id`, so replaying an event never creates a second line.
- One costed outside call = one `integrations.usage.recorded` = one line, and nothing else creates
  automatic lines. A call is priced in whole cents, half up (R3a Ruling 2), so a call priced under half a
  cent costs 0, publishes no usage record and records no line. `enrichment.request.completed` and `ai.run.completed` never create lines; from R3b
  they only tell Analytics which account a usage record with the same `correlationId` belongs to. If the usage record is processed first, its line is
  created with target none and re-targeted when the matching event arrives (an internal update before
  the line is shown, not an edit of a visible line).
- Prices for credits and tokens are set in Integrations; a usage record with no price records the
  quantity with a zero amount and flags "Price not set".

## Budgets and levels

R3a (Rulings 6-8 and 11 of the R3a plan):

- **Budgets.** `analytics.cost_budget(tenant_id, category, month 'YYYY-MM', amount_cents)`. A month's
  budget is its own row, else the latest earlier month's row. None, or 0, means no alert and no pause.
  `PUT /api/v1/costs/budgets` (`budgets:write`) saves the current or a future month; a past month gets
  409 "Past months can't be changed." `GET /api/v1/costs/budgets?month` (`costs:read`) reads one month.
- **Months.** A month is the calendar month in the tenant timezone. Spend leaves out voided lines.
- **Levels.** `ok` below 90% of the budget, `alert` from 90%, `over` from 100%, `paused` from 110%.
  Only AI usage and Data vendors can pause; the others top out at `over`.
  `analytics.budget_state(tenant_id, category, month, level)` keeps the last level.
- **When.** A line added or voided recomputes its category for the current tenant month, and so does a
  budget saved for the current month. A line dated in another month changes the totals but no level. The
  state row is locked while the level is worked out, so two changes at once are both counted.
- **Event.** A level change publishes `analytics.budget.level_changed` v1
  `{ category, month, level, spentCents, budgetCents, seq }` in the same transaction. `seq` is the
  category month's change count in `budget_state`, bumped under its lock, so a late older event can be
  ignored. A new month starts at
  `ok`, so a pause ends at the month boundary.
- **Summary.** `GET /api/v1/costs/summary` (`costs:read`) gives `month`, `spend_month_cents`,
  `budget_month_cents` (the categories' budgets summed), `spend_90d_cents` (the last 90 days up to
  today), `categories[]` (`key`, `label`, `spend_90d_cents`, `spend_month_cents`, `budget_cents`,
  `level`, `pausable`) and `months[]` (the last 6 months with `spend_cents` and the summed
  `budget_cents`). R3b-1 adds, over the same 90 days: `cost_per_sent_cents` (the ledger total over the
  journeys that arrived), `cost_per_won_cents` (over the journeys that first entered the last flow stage),
  `return_ratio` (won deal amounts with `closed_at` in the 90 days over the spend, 1 decimal, null with no
  spend; a won deal with no amount adds nothing) and `target_cost_per_won_cents`.

## Source target (R3b-1, as built)

- **Lines.** `cost_line.source_id` (null). `integrations.usage.recorded` carries an optional `sourceId`:
  intake's arrival normalise call passes the arrival's closest source, and CSV column mapping the import's
  source. `POST` and `PATCH /api/v1/costs/lines` take an optional `source_id`; an unknown or removed source
  gets 400 "Choose a source that exists." An edit that keeps the line's current source passes even if that
  source was removed since. The lines list returns `source_id` and `source_name`.
- **Target cost per won account.** One workspace setting, `analytics.cost_setting(tenant_id,
  target_cost_per_won_cents, updated_by, updated_at)`, no default. `PUT /api/v1/costs/target`
  `{ target_cost_per_won_cents: number | null }` (`budgets:write`, people only); below 1 gets 400 "Enter a
  target above zero, or clear it." and null clears it. It is read back in `/costs/summary`.
- **Spend per source.** Non-voided lines only. A line with a `source_id` belongs to that source, else a
  line with an `account_id` to that account's first source, else it is Shared costs. A source's spend
  rolls up everything below it in the source tree.
- **Cost by source.** `GET /api/v1/costs/by-source` (`costs:read`), over the last 90 days: rows
  `{ source_id, name, kind, spend_cents, share_pct, per_sent_cents, per_assigned_cents, per_won_cents,
  return_ratio }` for each top-level, non-removed source with spend or accounts sent, by spend descending
  (then name); then `{ source_id: null, name: "Shared costs", spend_cents, share_pct }`; plus
  `total_spend_cents`. A `per_*` value is null when its count is 0. Shared costs also holds spend that shows in
  no row (under a removed top-level source), so the spends always add up to the total.

## Allocation

The spread below is not built: R3b-1 attributes spend per source as above, without spreading lines to
accounts. To get cost per account and per source, lines would be spread to accounts (pure function
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
