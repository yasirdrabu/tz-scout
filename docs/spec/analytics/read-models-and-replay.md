# ANL-E7 Read models and replay

Release R3 · Module ANL

## Why

Analytics owns no business state, so its tables must be rebuildable from events at any time: after a
bug fix, after adding a new view, or after migrating data.

## Rules

- Each read model has one consumer on `SCOUT_EVENTS`, ordered by `accountId`, idempotent through
  `platform.processed_event`.
- **Rebuild:** an owner or platform admin can rebuild a tenant's analytics. The job clears that
  tenant's read models (not the cost ledger's manual lines), replays `SCOUT_EVENTS` from the start of
  retention (90 days), and for older history publishes a `jobs.history.republish` job to each owning
  module (REV, SRC, CRM, PLB, INT). Each re-publishes its stored history as the same event types,
  marked `replay: true`, on `scout.<tenant>.replay.>`, which only the rebuilding consumer reads.
  Analytics stays events-only (it never calls those modules synchronously), and other consumers never
  see replayed events.
- During a rebuild the pages show "Rebuilding, numbers may be incomplete" with progress.
- The migration from v1 (see `migration-and-rollout/data-migration.md`) ends with a full rebuild.

## Stories

### ANL-E7-S1 Rebuild a tenant's analytics
As a platform admin, I want to rebuild analytics from source data, so that a fix or a new view applies
to all history.
- ANL-E7-S1-AC1 After a rebuild, the journey table equals the one built live (test: build live from a
  scripted event sequence, rebuild, compare).
- ANL-E7-S1-AC2 Manual cost lines and voids survive a rebuild unchanged; auto lines are rebuilt from
  origin events without duplicates.
- ANL-E7-S1-AC3 History older than event retention is filled from the owning modules' republished
  history; no other consumer acts on a `replay: true` event.

### ANL-E7-S2 Freshness
As a CRO, I want numbers that are current, so that I trust them in a meeting.
- ANL-E7-S2-AC1 A stage change is reflected in the funnel within 1 minute (p95) of its event.
- ANL-E7-S2-AC2 Each analytics page shows "Updated <time>" from the consumer cursor.
