# ACC-E5 Merges and aliases

Status: Draft · Release: R1

## Why

Duplicate checks catch most repeats, but some slip through (a subsidiary domain, a renamed company).
People must be able to merge two accounts, and every module holding the old id must follow.

## Rules

- An owner or leader (a person with `accounts:write`, never an API key) picks a survivor and a merged account. Merging:
  - moves people (de-duplicated by email, then LinkedIn, then name), facts, signals and aliases to the
    survivor; the merged account's domain and name become aliases; its id becomes a `merged_id` alias;
  - re-runs the current-value rule and conflict detection on the survivor;
  - archives the merged account with reason `merged`;
  - publishes `accounts.account.merged { survivorId, mergedId }`. Every module that stores account ids
    (SRC, SCO, REV, PLB, CRM, ANL) must repoint its rows in its consumer.
- Merging two accounts both already pushed to the CRM is allowed only when they point to the same CRM
  company; otherwise the merge is refused with "These are different companies in HubSpot. Merge them
  there first." ACC asks through `MergeGuard.check(ctx, survivorId, mergedId) → { allowed, reason? }`,
  an interface ACC defines in `accounts/contracts` and CRM implements from its `crm.link` rows; the
  composition root wires it, so ACC never imports CRM (spec's call, D29). With no guard registered,
  merges are allowed.
- Requests for a merged id (API, MCP, links) return the survivor with `merged_into` set.
- Outside ids (`hubspot`, `apollo`, `vibe`) are aliases of kind `external_id` with the system name.
- No unmerge in this version; the merge confirmation says so.

## Stories

### ACC-E5-S1 Merge two accounts
As a leader, I want to merge duplicate accounts, so that the team sees one company.
- ACC-E5-S1-AC1 The merge dialog shows both accounts side by side (name, domain, people count, owner,
  stage) and which will survive; confirming merges as in Rules.
- ACC-E5-S1-AC2 After a merge, an arrival for the merged domain attaches to the survivor.
- ACC-E5-S1-AC3 `GET /api/v1/accounts/{mergedId}` returns the survivor with `merged_into`.
- ACC-E5-S1-AC4 An integration test merges two accounts with plans, assignments and handoffs and
  checks every module repointed its rows.
