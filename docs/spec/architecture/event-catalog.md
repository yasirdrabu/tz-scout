# Event and tool catalog

The names every module agrees on. Event type prefix = the owning module's schema name. Each module
spec documents the `data` fields of its own events; this list is the index. Add a row here when a
module adds an event or tool.

## Events

| Event type | Owner | Meaning | Main consumers |
|---|---|---|---|
| `tenancy.tenant.created` | TEN | A platform admin created a tenant; data `tenantId`, `slug`, `createdBy` | every module that seeds tenant defaults |
| `tenancy.api_key.created` / `.revoked` | TEN | A key was issued or revoked | INT (usage), audit |
| `tenancy.member.added` / `.removed` | TEN | A person joined or left a tenant | REV (seller lists) |
| `tenancy.member.role_changed` | TEN | Role or permissions changed | REV, audit |
| `tenancy.oauth_grant.created` / `.revoked` | TEN | An AI app connected or was disconnected | audit |
| `intake.batch.created` | SRC | A batch was opened | ANL |
| `intake.arrival.received` | SRC | An arrival was stored as received | SRC (resolve job) |
| `intake.arrival.resolved` | SRC | Arrival matched to an existing account or created one | SCO (scores the account once for the whole arrival), REV, ANL, webhooks |
| `intake.arrival.rejected` | SRC | Arrival could not be used (invalid, excluded, over cap) | ANL, webhooks |
| `intake.batch.completed` | SRC | Every arrival in a batch is resolved or rejected | ANL, webhooks |
| `intake.source.trust_changed` | SRC | A source's trust score moved, or an introducer's warm-intro points changed (`cause`) | SCO (rescores that source's accounts with cause `trust_changed`) |
| `intake.arrival.waiting` | SRC | An arrival needs a person (website, company, possible duplicate); stays `resolving` | REV (queue badge), webhooks |
| `intake.warm_intro.confirmed` | SRC | An agent-declared warm intro was confirmed | SCO (rescore) |
| `intake.feedback.recorded` | SRC | A source was told why its arrival lost a conflict, was sent back or declined at review, or was declined by a seller. One per distinct source in the chain, per cause. Data: `sourceId`, `arrivalId`, `accountId`, `kind` (`conflict_lost`, `declined_at_review`, `sent_back`, `declined_by_seller`, `enrichment_declined`), `reasonKey`, `note` | webhooks |
| `accounts.account.exclusion_changed` | ACC | Account ruled out, or a person overrode a rule. Optional `arrivalId` | SCO (rescore), REV |
| `enrichment.search.completed` | ENR | A saved-search run finished (maybe partial) | ANL (counts only; cost comes from INT usage) |
| `accounts.account.created` / `.updated` / `.archived` | ACC | Account lifecycle. `created` and `updated` carry an optional `arrivalId` when an arrival caused them, and optional `externalIds` (the outside ids this write added; CRM turns them into links) | SCO, CRM, ANL |
| `accounts.account.merged` | ACC | Two accounts became one; carries `survivorId`, `mergedId` | every module holding account ids |
| `accounts.person.added` / `.updated` | ACC | Person lifecycle, including buying role changes. Optional `arrivalId` when an arrival caused it, and optional `externalIds` (the outside ids this write added) | SCO, PLB, CRM |
| `accounts.fact.recorded` | ACC | A fact was stored with provenance. Optional `arrivalId` | SCO |
| `accounts.signal.recorded` | ACC | A dated signal was stored. Optional `arrivalId` | SCO |
| `accounts.conflict.detected` | ACC | Two sources disagree on a fact | REV (shows on page) |
| `accounts.conflict.resolved` | ACC | A person kept one value; carries the losing source | SRC (trust feedback) |
| `enrichment.request.flagged` | ENR | An agent or person asked for enrichment | REV (queue badge) |
| `enrichment.request.approved` / `.declined` | ENR | A person decided on spend | ENR (run job) |
| `enrichment.request.completed` / `.failed` | ENR | Provider run finished (results reach ACC as arrivals through SRC) | ANL (counts only; cost comes from INT usage), webhooks |
| `scoring.account.scored` | SCO | New scores, tier and best offer for an account; carries `version` (`account_score.version`). Published only when priority, tier or best offer moved, or on the first score | ACC (account summary), PLB, ANL, webhooks |
| `scoring.rules.changed` | SCO | Weights, rules or warm-intro points changed | SCO (rescore) |
| `offers.offer.approved` / `.archived` / `.changed` | OFF | Offer lifecycle | SCO (rescore), PLB |
| `routing.review.changed` | REV | After every write to an account's review: `accountId`, `version` (`account_review.version`) and a full `snapshot` (`reviewStatusKey`, `ownerUserId`, `ownerHistoryUserIds`, `hasOpenAssignment`, `stage`, `reviewFlags`) | ACC (account summary) |
| `routing.status.changed` | REV | Review status moved; carries `from`, `to` | ANL, webhooks |
| `routing.assignment.created` | REV | Leader assigned an account to a seller. Carries `bulkId` (null for a single assign; one `blk_` id for every assignment in one bulk action), which CRM uses to group handoffs into one batch | CRM (handoff), PLB (plan), ANL |
| `routing.assignment.accepted` / `.declined` | REV | Seller response; decline carries the reason and its `reasonLabel` (the words the person saw) | ANL, SRC (trust), CRM (decline undoes handoff), PLB (pause plan) |
| `routing.assignment.withdrawn` | REV | Assigner withdrew or replaced an open assignment | CRM (undo handoff), PLB |
| `routing.stage.changed` | REV | Account moved funnel stage (arrived to won, or an exit) | ANL, SRC (status for agents), webhooks |
| `crm.handoff.completed` / `.failed` | CRM | Account pushed to the CRM (or failed). `completed` carries `companyLifecycle` (`none`, `open_deal`, `customer`) and `observedAt` | ANL, webhooks, REV (handoff flag), ACC (`crm_status`) |
| `crm.handoff.cancelled` | CRM | A handoff was declined, withdrawn or stopped before it finished, or a completed handoff was undone. Internal | REV (handoff flag) |
| `crm.company.checked` | CRM | The CRM check before review: whether the account's company exists in the CRM, who owns it, and `companyLifecycle`, with `observedAt` | ACC (`crm_status`) |
| `crm.lead.qualified` | CRM | A contact's lifecycle change matched the qualified-lead rule (`connectionId`, `contactId`). Internal; it keeps CRM from importing Intake | SRC (arrival) |
| `crm.activity.observed` | CRM | Email, call, meeting or task seen in the CRM since handoff | PLB, ANL |
| `crm.deal.changed` | CRM | Deal created or moved (open, won, lost) with amount; carries `companyLifecycle` and `observedAt` | PLB, ANL, SRC (trust), OFF (wins), REV (stage), ACC (`crm_status`) |
| `playbooks.plan.created` / `.changed` | PLB | Account plan applied or edited | CRM (tasks), ANL |
| `playbooks.step.completed` | PLB | A step was done | ANL |
| `playbooks.outcome.recorded` | PLB | Reply, meeting, opportunity, won or lost on an account | SRC (trust), ANL |
| `playbooks.learning.recorded` | PLB | Retro written; may propose a template edit | PLB, ANL |
| `playbooks.brief.updated` | PLB | Brief sections drafted or edited | CRM (refresh note on next push) |
| `offers.practice.changed` | OFF | Practice created, renamed or archived | SCO, PLB |
| `offers.win_analysis.completed` | OFF | Win analysis run finished | ANL |
| `crm.handoff.needs_decision` | CRM | CRM state changed since preflight; the push stopped for a person to decide | REV (handoff flag) |
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

## Jobs

Jobs travel the same way as events, as `jobs.<name>` messages. Each module spec describes what its jobs do.

| Job | Owner | Meaning |
|---|---|---|
| `intake.resolve` | SRC | Runs the resolve pipeline for one arrival |
| `intake.import.run` | SRC | Reads an uploaded file with its confirmed mapping and submits companies in chunks of 500; the next chunk is queued in the same transaction, with the cursor kept on the import |
| `intake.waiting.expire` | SRC | Rejects arrivals that waited 30 days for a person. A per-tenant schedule, daily at 04:00 UTC |
| `accounts.exclusions.recheck` | ACC | Re-evaluates exclusion across a tenant's accounts after a rule or list changed |
| `scoring.rescore.page` | SCO | Lists up to 200 account ids matching a filter (all, practice, source or offer), queues `scoring.rescore.accounts` for them and queues the next page |
| `scoring.rescore.accounts` | SCO | Scores up to 200 accounts, each in its own savepoint; a failed account is queued again on its own. Timeout 300 seconds |
| `scoring.ageing` | SCO | Nightly, per tenant at 02:00 UTC: rescores accounts with a signal under a year old whose score is over 20 hours old, cause `ageing` |
| `routing.assignments.auto_accept` | REV | Hourly, per tenant: accepts pending assignments that waited out the workspace's working days (at most 500 per run) |
| `intake.qualified_leads.poll` | SRC | Every 15 minutes, per tenant: reads HubSpot contacts that became qualified since the last poll (at most 200 a run, oldest first, 5 minutes of overlap) and submits each as an arrival |
| `crm.company.check` | CRM | Checks one account's company in the CRM before review; enqueued when an account is created or its domain changes, and by the R1c backfill |
| `crm.handoff.push` | CRM | Pushes one handoff. Delivered up to 7 times: the first 6 runs are push attempts (retryable errors are rethrown), the 7th only marks a handoff `failed` if the job died. Retries wait 30 seconds, 2, 10 and 30 minutes, then an hour (HubSpot's search index lags, so a quick retry could create a second company). Timeout 120 seconds |
| `crm.handoff.undo` | CRM | Undoes a handoff after a decline or withdrawal: closes Scout's open tasks, returns ownership, adds a short note |
| `crm.person.push` | CRM | Pushes one person added after the handoff, when the tenant setting is on. Retries back off as `crm.handoff.push` does |
| `crm.activity.poll` | CRM | Every 15 minutes, per tenant: picks up to 200 handed-off accounts (latest handoff completed within 180 days, least recently checked or queued first), stamps `follow_through.sync_queued_at` and queues one `crm.sync` each. It takes no account lock and makes no CRM call itself, and an account whose sync keeps failing goes to the back |
| `crm.deals.poll` | CRM | Hourly, per tenant: reads deals changed since the last poll (at most 1,000, oldest change first) and keeps those on linked companies. After a full page the cursor moves to the last deal's modified time, not to now. A webhook about a deal Scout has not seen queues one at most every 5 minutes |
| `crm.owners.sync` | CRM | Daily at 05:00 UTC, per tenant: reads the CRM's owner roster (up to 2,000 owners) |
| `crm.sync` | CRM | Reads one account's follow-through, activity and deals now (from the activity poll, a webhook or "Check follow-through"), under the account lock. Timeout 120 seconds |

## Versions and arrival ids

`scoring.account.scored` and `routing.review.changed` carry a `version`. Accounts overwrites its summary columns only when the event's version is newer than the one stored, so late or repeated delivery cannot leave stale state. Accounts events caused by an arrival carry that `arrivalId`; scoring skips them because `intake.arrival.resolved` scores the account once. An arrival rejected as excluded still upserted the account, so scoring scores it from `intake.arrival.rejected` when that carries an `accountId`.

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

Returns: an assignment that is declined by the seller (pending or accepted) or withdrawn by the leader sends the stage back to Reviewed; reopening a declined account sends it back to Arrived.

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
