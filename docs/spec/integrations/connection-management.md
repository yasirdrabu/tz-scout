# INT-E1 Connections and mock or live

Release R0 (mode switch, skeleton), R1 (full page)

## Why

Today integrations are switched by environment variables for the whole app. Each tenant needs to set
up its own (D18, answer 28), and the app must still run end to end on mocks with seed data.

## Rules

- One connection per provider per tenant, except CRMs and prospect vendors, which may have more than
  one (e.g. two HubSpot portals) with a `name`.
- Mode per connection: `mock` or `live`. New tenants start with every connection in `mock`.
- A platform-wide env var `SCOUT_FORCE_MOCK=true` forces mock for every tenant (laptop, CI, sandbox
  tenants). Test API keys always use mock adapters.
- Switching to live requires a credential and a passing test in the last 10 minutes.
- Status: `not_set_up` (no credential), `connected` (last test or call ok), `failing` (3 consecutive
  failed calls or a failed test), `disabled` (owner turned it off; calls are refused with a clear
  error).

## Page: Settings → Integrations

A table, one row per provider: name, what it's used for (one line), mode chip (Mock or Live), status
chip, last successful call, calls today, usage against cap this month, and a Set up / Manage button.
Manage opens a panel with: credential fields (masked, with hint), non-secret settings, Test button,
mode switch, caps, and the last 50 calls.

Copy: "Mock" chip reads "Using sample data"; failing reads "Failing: <last error in plain words>".

## Stories

### INT-E1-S1 See every integration at a glance
As an owner, I want one page listing every integration with its mode and health, so that I know what
Scout is connected to.
- INT-E1-S1-AC1 Every provider in providers list appears, including ones not set up.
- INT-E1-S1-AC2 Status and last call refresh without reloading (every 30 seconds).

### INT-E1-S2 Switch mock and live
As an owner, I want to switch a connection between sample data and live, so that I can try Scout
before connecting real systems.
- INT-E1-S2-AC1 Switching to live without a credential or a recent passing test is refused with "Test
  the connection first."
- INT-E1-S2-AC2 `integrations.connection.changed` is published and the audit log records who.
- INT-E1-S2-AC3 With `SCOUT_FORCE_MOCK=true`, the switch is shown disabled with "This environment uses
  sample data only."

### INT-E1-S3 Disable a connection
As an owner, I want to disable a connection without deleting it, so that I can stop calls during an
incident.
- INT-E1-S3-AC1 While disabled, `gateway.call` fails fast with error `connection_disabled`; jobs that
  need it are retried later, not dead-lettered, for up to 24 hours.

### INT-E1-S4 Failing connection notice
As an owner, I want to be told when a connection starts failing, so that handoffs don't quietly stop.
- INT-E1-S4-AC1 When a connection becomes `failing`, owners get an in-app notice and an email with the
  last error and a link to the call log.
