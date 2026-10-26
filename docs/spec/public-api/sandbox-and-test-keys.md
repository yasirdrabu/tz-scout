# API-E5 Sandbox and test keys

Release R1

## Why

Agent builders need to try Scout without polluting the real review queue, spending credits, or
writing to the CRM.

## Rules

- Every tenant has a linked sandbox tenant (`<slug>-sandbox`), created with it. It has the same
  practices, offers, playbooks, scoring rules and settings (copied nightly and on demand), sample
  accounts, and every integration forced to mock.
- `scout_test_` keys and OAuth grants marked "test" act on the sandbox tenant only. `scout_live_` keys
  never reach the sandbox.
- Owners and leaders can open the sandbox from the tenant switcher to see what test agents sent; it
  is labelled "Sandbox: sample data, nothing reaches your CRM."
- Sandbox data older than 30 days is deleted nightly.

## Stories

### API-E5-S1 Try without risk
As an agent builder, I want a test key that behaves like the real thing, so that I can build safely.
- API-E5-S1-AC1 An arrival sent with a test key is resolved, scored and can be assigned in the sandbox;
  a push goes to the mock CRM and appears in the sandbox call log.
- API-E5-S1-AC2 No live integration call is made for any sandbox action (verified by call log mode).

### API-E5-S2 Reset the sandbox
As an owner, I want to reset the sandbox, so that tests start clean.
- API-E5-S2-AC1 "Reset sandbox" deletes its accounts, arrivals and batches and recopies settings.
