# ACC-E8 Account search

Status: Draft · Release: R1

## Why

People and agents need to find accounts by criteria: "logistics companies in Florida that are act now
for Modernization Blueprint and have no owner yet". Search spans data owned by several modules, so ACC
keeps a read model (`account_summary`) fed by their events.

## Rules

- `account_summary` holds, per account: priority, fit, intent, tier, best offer, practice (SCO); review
  status, owner, stage (REV, CRM); source ids (SRC); last signal date (ACC). Updated by consumers
  within seconds of each event.
- **Filters**: text (name, domain, alias), industry, employees range, revenue range, HQ country and
  state, practice, best offer, tier, priority at least, review status, stage, owner (or unassigned),
  source, has signal of kind since date, excluded or not.
- **Sort**: priority (default), last signal, created, name.
- **Data limits** apply before anything else: a principal limited to `own_source` sees only accounts
  with at least one arrival from its source; a seller limited to "my accounts" sees only accounts they
  own; practice-limited principals see only accounts whose best offer is in their practices.
- Results are paged (cursor, 50 default, 200 max).

## Stories

### ACC-E8-S1 Search in the web app
As a leader, I want to filter and sort accounts, so that I can build my review list.
- ACC-E8-S1-AC1 The Accounts list supports every filter above, shows priority, tier, best offer,
  status, owner and last signal, and keeps filters in the URL.
- ACC-E8-S1-AC2 Results for 10,000 accounts return in under 500 ms p95.

### ACC-E8-S2 Agents find accounts
As an agent, I want to find accounts by criteria, so that I can enrich or report on them.
- ACC-E8-S2-AC1 `find_accounts` accepts the filters as named fields and returns up to 50 accounts
  (default 10) with id, name, domain, tier, priority, best offer and stage, plus a `summary`.
- ACC-E8-S2-AC2 An agent limited to `own_source` never sees another source's accounts (integration
  test).

## MCP tools

`find_accounts`, as defined in [mcp/agent-tools.md](../mcp/agent-tools.md): input `query`, `domain`,
`practice`, `offer`, `tier`, `stage`, `signal_type` (a kind), `limit`, `cursor`; output items with
`account_id`, `name`, `domain`, `tier`, `priority`, `best_offer`, `stage`, plus `next_cursor` and
`summary`. The web app and `GET /v1/accounts` support the fuller filter list above.
