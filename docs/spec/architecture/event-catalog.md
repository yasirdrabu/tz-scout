# Event and tool catalog

The names every module agrees on. Event type prefix = the owning module's schema name. Each module
spec documents the `data` fields of its own events; this list is the index. Add a row here when a
module adds an event or tool.

## Events

| Event type | Owner | Meaning | Main consumers |
|---|---|---|---|
| `tenancy.api_key.created` / `.revoked` | TEN | A key was issued or revoked | INT (usage), audit |
| `tenancy.member.added` / `.removed` | TEN | A person joined or left a tenant | REV (seller lists) |
| `tenancy.member.role_changed` | TEN | Role or permissions changed | REV, audit |
| `tenancy.oauth_grant.created` / `.revoked` | TEN | An AI app connected or was disconnected | audit |
| `intake.batch.created` | SRC | A batch was opened | ANL |
| `intake.arrival.received` | SRC | An arrival was stored as received | SRC (resolve job) |
| `intake.arrival.resolved` | SRC | Arrival matched to an existing account or created one | SCO, REV, ANL, webhooks |
| `intake.arrival.rejected` | SRC | Arrival could not be used (invalid, excluded, over cap) | ANL, webhooks |
| `intake.batch.completed` | SRC | Every arrival in a batch is resolved or rejected | ANL, webhooks |
| `intake.source.trust_changed` | SRC | A source's trust score moved, or an introducer's warm-intro points changed (`cause`) | SCO (rescore that source's accounts) |
| `intake.arrival.waiting` | SRC | An arrival needs a person (website, company, possible duplicate); stays `resolving` | REV (queue badge), webhooks |
| `intake.warm_intro.confirmed` | SRC | An agent-declared warm intro was confirmed | SCO (rescore) |
| `intake.feedback.recorded` | SRC | A source was told why its arrival lost a conflict or was declined | webhooks |
| `accounts.account.exclusion_changed` | ACC | Account ruled out, or a person overrode a rule | SCO (rescore), REV |
| `enrichment.search.completed` | ENR | A saved-search run finished (maybe partial) | ANL (counts only; cost comes from INT usage) |
| `accounts.account.created` / `.updated` / `.archived` | ACC | Account lifecycle | SCO, CRM, ANL |
| `accounts.account.merged` | ACC | Two accounts became one; carries `survivorId`, `mergedId` | every module holding account ids |
| `accounts.person.added` / `.updated` | ACC | Person lifecycle, including buying role changes | SCO, PLB, CRM |
| `accounts.fact.recorded` | ACC | A fact was stored with provenance | SCO |
| `accounts.signal.recorded` | ACC | A dated signal was stored | SCO |
| `accounts.conflict.detected` | ACC | Two sources disagree on a fact | REV (shows on page) |
| `accounts.conflict.resolved` | ACC | A person kept one value; carries the losing source | SRC (trust feedback) |
| `enrichment.request.flagged` | ENR | An agent or person asked for enrichment | REV (queue badge) |
| `enrichment.request.approved` / `.declined` | ENR | A person decided on spend | ENR (run job) |
| `enrichment.request.completed` / `.failed` | ENR | Provider run finished (results reach ACC as arrivals through SRC) | ANL (counts only; cost comes from INT usage), webhooks |
| `scoring.account.scored` | SCO | New scores, tier and best offer for an account | REV, PLB, ANL, webhooks |
| `scoring.rules.changed` | SCO | Weights, rules or warm-intro points changed | SCO (rescore) |
| `offers.offer.approved` / `.archived` / `.changed` | OFF | Offer lifecycle | SCO (rescore), PLB |
| `routing.status.changed` | REV | Review status moved; carries `from`, `to` | ANL, webhooks |
| `routing.assignment.created` | REV | Leader assigned an account to a seller | CRM (handoff), PLB (plan), ANL |
| `routing.assignment.accepted` / `.declined` | REV | Seller response; decline carries reason | ANL, SRC (trust), CRM (decline undoes handoff), PLB (pause plan) |
| `routing.assignment.withdrawn` | REV | Assigner withdrew or replaced an open assignment | CRM (undo handoff), PLB |
| `routing.stage.changed` | REV | Account moved funnel stage (arrived to won, or an exit) | ANL, SRC (status for agents), webhooks |
| `crm.handoff.completed` / `.failed` | CRM | Account pushed to the CRM (or failed) | ANL, webhooks |
| `crm.activity.observed` | CRM | Email, call, meeting or task seen in the CRM since handoff | PLB, ANL |
| `crm.deal.changed` | CRM | Deal created or moved (open, won, lost) with amount | PLB, ANL, SRC (trust), OFF (wins) |
| `playbooks.plan.created` / `.changed` | PLB | Account plan applied or edited | CRM (tasks), ANL |
| `playbooks.step.completed` | PLB | A step was done | ANL |
| `playbooks.outcome.recorded` | PLB | Reply, meeting, opportunity, won or lost on an account | SRC (trust), ANL |
| `playbooks.learning.recorded` | PLB | Retro written; may propose a template edit | PLB, ANL |
| `playbooks.brief.updated` | PLB | Brief sections drafted or edited | CRM (refresh note on next push) |
| `offers.practice.changed` | OFF | Practice created, renamed or archived | SCO, PLB |
| `offers.win_analysis.completed` | OFF | Win analysis run finished | ANL |
| `crm.handoff.needs_decision` | CRM | CRM state changed since preflight; the push stopped for a person to decide | REV (queue flag) |
| `campaigns.test.launched` / `.completed` | CMP | Message test lifecycle | ANL |
| `campaigns.statement.decided` | CMP | Keep, drop, rewrite or retest, with verdict | PLB (winning words) |
| `campaigns.ad_spend.recorded` | CMP | One day's spend for one ad campaign | ANL (automatic cost line) |
| `campaigns.meeting.booked` / `.held` / `.no_show` / `.cancelled` | CMP | Meeting lifecycle from the booking flow | PLB (meeting outcome), ANL |
| `analytics.cost.recorded` | ANL | A cost line was added | ANL |
| `analytics.diagnosis.created` | ANL | Weekly diagnosis stored | owners (notify) |
| `integrations.connection.changed` / `.tested` | INT | Connection added, edited, tested | Admin |
| `integrations.usage.threshold_reached` | INT | 80% or 100% of a cap | owners (notify) |
| `integrations.usage.recorded` | INT | An outside call with a cost (credits, tokens) finished | ANL (automatic cost lines) |
| `ai.run.completed` | AI | An AI task ran (cost, tokens) | ANL (cost) |
| `platform.job.dead` | PLT | A job exhausted its retries | Admin |

## Account funnel stages (D15) and the events that move them

Review and routing (REV) owns stage tracking: it consumes the triggers below, computes the account's
stage and publishes `routing.stage.changed` (`from`, `to`, `cause_event_id`). Analytics, SRC status
replies and webhooks read stages only from `routing.stage.changed`, never from the triggers directly.
Details in `review-and-routing/stage-tracking-and-status.md`.

| Stage | REV moves the account here on |
|---|---|
| Arrived | `intake.arrival.resolved` (first arrival for the account from that source) |
| Reviewed | `routing.status.changed` to a status marked "counts as reviewed" |
| Assigned | `routing.assignment.accepted` (explicit, or implied by CRM activity or 2 working days without a decline, D22) |
| Engaged | first `crm.activity.observed` of kind reply or meeting, or `playbooks.outcome.recorded` reply or meeting |
| Opportunity | first `crm.deal.changed` with status open |
| Won | `crm.deal.changed` status won |
| Exits: Lost, Declined | `crm.deal.changed` status lost; `routing.status.changed` to Declined |

## MCP tools

| Tool | Module | Does |
|---|---|---|
| `submit_account` | SRC | Send one account (with optional people, facts, signals, warm intro) |
| `submit_batch` | SRC | Send many accounts with batch notes and files |
| `get_batch_status` | SRC | Counts and per-item status for a batch |
| `list_my_submissions` | SRC | What this source sent, with current stage |
| `get_account_status` | REV | Stage, review status, owner, last activity for one account |
| `find_accounts` | ACC | Search accounts by criteria the principal may see |
| `get_account_brief` | PLB | The brief, scores, why now, committee and plan for an account |
| `explain_score` | SCO | Why an account has its score and tier, factor by factor |
| `add_person` | ACC | Add a person with buying role to an account |
| `add_signal` | ACC | Add a dated signal with a source link to an account |
| `flag_for_enrichment` | ENR | Ask for enrichment; a person approves |
| `list_offers` | OFF | Practices and approved offers, for agents to target |
| `get_source_performance` | ANL | How the calling source's accounts converted: funnel, decline reasons, trust trend |
