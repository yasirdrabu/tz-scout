# INT-E3 Test connection and call log

Release R1

## Why

People need to know a connection works before relying on it, and to see exactly what Scout did on
their behalf: which module, for which key or agent, with what result and cost.

## Rules

- Each adapter implements `test()`: a cheap read-only call (HubSpot: read account info; Apollo:
  health or a 1-record search with no credit cost; Claude: count tokens; Microsoft: token request).
  Test never writes and never spends credits.
- Every outside call through the gateway writes one `call_log` row. Request summaries keep the
  operation, record counts and outside ids; they drop secrets, email addresses, phone numbers and free
  text. Errors keep the provider's message, trimmed to 500 characters.
- The call log is per tenant. Platform admins can see it with support access.

## Stories

### INT-E3-S1 Test a connection
As an owner, I want a Test button that tells me in plain words whether the connection works, so that I
can fix setup problems myself.
- INT-E3-S1-AC1 The result appears within 10 seconds: "Connected to HubSpot portal 2257150." or a
  specific failure ("The token was refused. Check it has the crm.objects.companies.write scope.").
- INT-E3-S1-AC2 Missing permissions the adapter needs are listed by name.
- INT-E3-S1-AC3 `integrations.connection.tested` is published.

### INT-E3-S2 Activity log
As an owner, I want a filterable list of calls, so that I can see what Scout did and why something
failed.
- INT-E3-S2-AC1 Filters: provider, outcome, module, API key, date range, correlation id.
- INT-E3-S2-AC2 Each row shows time, operation in plain words ("Updated company in HubSpot"), who
  caused it (person, key name, or "Scheduled"), outcome, duration, units and cost.
- INT-E3-S2-AC3 Clicking a correlation id shows every call and event from the same request or batch.
- INT-E3-S2-AC4 Export the filtered list as CSV.

### INT-E3-S3 Error summary
As an owner, I want errors grouped, so that one recurring problem isn't hidden among hundreds of rows.
- INT-E3-S3-AC1 The Manage panel shows the top 3 error messages in the last 7 days with counts.
