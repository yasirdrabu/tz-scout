# REV-E4 Stage tracking and account status

Release R1

## Why

Leaders, AEs and the agents that sent accounts all ask the same question: where is this account now?
One place keeps the answer, from the events that move it.

## Rules

Stages and what moves them (from `architecture/event-catalog.md`):

| Stage | Entered on |
|---|---|
| `arrived` | `intake.arrival.resolved` for a new account |
| `reviewed` | `routing.status.changed` to a status that counts as reviewed (not declined) |
| `assigned` | `routing.assignment.accepted` |
| `engaged` | first reply or meeting (`crm.activity.observed` or `playbooks.outcome.recorded`) |
| `opportunity` | first open deal (`crm.deal.changed`) |
| `won` | deal won |
| `lost` (exit) | deal lost |
| `declined` (exit) | status changed to a declined status |

- Stages only move forward, except: a decline of an assignment returns to `reviewed`, whether the
  seller declines it pending or after accepting it; a withdrawn assignment returns to `reviewed` too (the
  leader must act on the account again, as after a decline); reopening a declined account returns to
  `arrived`; a new open deal after `lost` returns to `opportunity`.
- Every move writes `stage_change` and publishes `routing.stage.changed`, which Analytics uses for the
  funnel and Sources and intake uses for status replies to agents.
- The tracker on the account page shows: Arrived, Reviewed, Assigned, In CRM, Engaged, Opportunity,
  Won (with done, current, and not yet).

## Stories

### REV-E4-S1 Stage on every account
- REV-E4-S1-AC1 Each event in the table moves the stage within 5 seconds and writes a history row.
- REV-E4-S1-AC2 Replaying the same event does not move the stage twice.

### REV-E4-S2 Account status for agents and people
As an agent that sent an account, I want to ask its status, so that I can tell my person what
happened.
- REV-E4-S2-AC1 `get_account_status` and `GET /v1/accounts/{id}/status` return the shape fixed in
  `mcp/agent-tools.md`: account id, name, stage, review status, tier, owner name, last activity
  date, declined reason and a one-sentence summary. People with `crm:push` also get the handoff
  status and CRM link in the web app and API.
- REV-E4-S2-AC2 An agent may pass the `arrival_id` it got when submitting instead of the account id;
  Sources and intake resolves it to the account, and the lookup is limited to arrivals from its
  source.
- REV-E4-S2-AC3 Accounts outside the principal's data scope return "not found".
- REV-E4-S2-AC4 If the account was declined or sent back, the reason and note are included so the
  agent can learn: `declined_reason` and `declined_note` for a declined status, `send_back_note` for a
  send back. A seller's decline of an assignment is not shown here; it reaches the source as feedback
  (SRC), so the two channels differ on purpose.
- REV-E4-S2-AC5 An agent that asks about its own arrival before it has an account gets stage `arrived`
  and "Received. Matching it to an account."; a rejected arrival gets "Not accepted: <reason>."
