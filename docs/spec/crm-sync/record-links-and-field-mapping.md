# CRM-E7 Record links and field mapping

Release R1 (links), R2 (mapping editor) · Module CRM

## Why

Scout keeps its own objects and the CRM ids that link back (v1 rule). Each tenant names its CRM fields
differently, so what Scout writes where has to be configurable without code.

## Rules

- Every pushed or matched CRM record gets a `crm.link` row: (`scout_type`, `scout_id`, `system`,
  `external_id`). Our primary keys never use CRM ids.
- Duplicate check (Sources and intake) asks this module's public interface `findLinkedAccount(ctx, system,
  externalId)` and `lookupCompany(ctx, domain)` (read only CRM call) so arrivals for companies already in
  the CRM are matched, and the review queue shows "Already in HubSpot, owned by <name>, lead stage".
- Field mapping rows decide which Scout fields go to which CRM properties on push, and which CRM
  properties are read back. Defaults per system are seeded. Fields not mapped are not sent.
- Transforms: none, cents to amount, date, enum map (for example tier keys to the CRM's option values).

## Stories

### CRM-E7-S1 Links
As a developer, I want one table of links, so that any module can ask "what is this account in the CRM".
- CRM-E7-S1-AC1 `getLinks(accountId)` returns the company, people, note, task and deal links.
- CRM-E7-S1-AC2 On `accounts.account.merged`, links move to the survivor; if both accounts had different
  CRM companies, both links stay and the account page shows "Two HubSpot companies are linked".

### CRM-E7-S2 CRM check before review
As a leader, I want to see whether an account is already in the CRM before I assign it, so that I
don't step on a colleague.
- CRM-E7-S2-AC1 For each resolved arrival, a read-only lookup by domain records whether the company
  exists, its owner, lifecycle and open deals.
- CRM-E7-S2-AC2 The lookup result is cached on the link for 24 hours.

### CRM-E7-S3 Field mapping editor
As an owner, I want to choose which Scout fields go to which CRM fields, so that reps can filter and
report in the CRM.
- CRM-E7-S3-AC1 Settings → CRM fields lists Scout fields with their mapped CRM property, direction and
  transform; owners can change, add and turn off rows.
- CRM-E7-S3-AC2 A mapping to a property that doesn't exist in the CRM is flagged "Not in HubSpot yet" and
  skipped on push.
- CRM-E7-S3-AC3 Changes apply to the next push; an owner can "Push all handed-off accounts again" to
  apply them now (queued, rate limited).
