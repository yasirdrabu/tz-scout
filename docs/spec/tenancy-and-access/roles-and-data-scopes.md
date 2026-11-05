# TEN-E3 Roles, permissions and data scopes

Release R0 (people), R1 (keys and OAuth use the same model)

## Why

"Any human can review, data is scoped." What someone may **do** (permissions) and which rows they
may **see** (data limit) are separate, and both are checked on every request: web, API and MCP.

## Permissions

Permissions are named `<resource>:<action>`. For API keys and OAuth grants they are called scopes;
they are the same strings.

| Permission | Allows |
|---|---|
| `accounts:read` | See accounts, scores, facts, signals |
| `accounts:write` | Edit account facts, merge, archive |
| `people:read` | See people and their contact details (emails, phones) |
| `people:write` | Add and edit people and buying roles |
| `signals:write` | Add signals to accounts |
| `arrivals:write` | Submit arrivals and batches (requires the principal to have a source) |
| `arrivals:read` | See arrivals and batches with their status |
| `imports:run` | Run CSV imports |
| `sources:manage` | Create and edit sources, warm-intro points |
| `enrichment:request` | Flag an account for enrichment |
| `enrichment:approve` | Approve or decline enrichment spend |
| `review:act` | Change review status, resolve conflicts, send back |
| `assign:act` | Assign accounts to sellers |
| `assignments:respond` | Accept or decline own assignments |
| `playbooks:read` | See account plans and briefs |
| `playbooks:write` | Edit account plans, steps, outcomes, learnings. Operators hold it by default: everyone who works an account can edit its plan (user, 2026-11-04) |
| `playbooks:manage` | Edit playbook templates |
| `offers:read` | See practices and offers |
| `offers:manage` | Create, edit, approve offers, practices, case studies |
| `scoring:manage` | Edit weights, signal rules, warm-intro points; trigger rescoring |
| `crm:push` | Push or re-push accounts to the CRM |
| `campaigns:read` | See message tests, the statement library and meetings |
| `campaigns:manage` | Message tests, ad funnel model, booking settings |
| `searches:manage` | Create, edit and schedule saved searches with a provider (creating one approves its spend) |
| `warm_intro:declare` | Declare a warm intro on a submitted account (unconfirmed unless the principal is a person source) |
| `analytics:read` | See funnel and scorecard (costs need `costs:read`) |
| `costs:read` | See the Costs page: spend, budgets and cost lines (R3a) |
| `costs:write` | Add, edit and void manual cost lines; void any line |
| `budgets:write` | Set the monthly budgets per cost category (R3a) |
| `integrations:manage` | Connections, credentials, caps |
| `members:read` | See members |
| `members:manage` | Add, remove, change members |
| `keys:manage` | Create, rotate, revoke API keys and OAuth clients |
| `webhooks:manage` | Register outgoing webhook endpoints |
| `settings:manage` | Tenant settings (statuses, roles, reasons) |
| `status:read` | See status and stage of accounts within the data limit (the minimum an agent needs to follow up) |
| `audit:read` | See the audit log |

## Roles (default permission sets)

| Permission group | Owner | Leader | Seller | Operator | Viewer |
|---|---|---|---|---|---|
| accounts, people, signals read/write | yes | yes | read + write on own | yes | accounts:read |
| arrivals, imports | yes | yes | arrivals:write | yes | no |
| sources:manage, scoring:manage | yes | yes | no | yes | no |
| enrichment:request | yes | yes | yes | yes | no |
| enrichment:approve | yes | yes | no | no | no |
| review:act | yes | yes | grantable | yes (web-ui W6) | no |
| assign:act | yes | yes | no | no | no |
| assignments:respond | yes | yes | yes | no | no |
| playbooks read/write | yes | yes | yes | yes | no |
| playbooks:manage | yes | yes | no | yes | no |
| offers:read | yes | yes | yes | yes | yes |
| offers:manage | yes | no | no | yes | no |
| crm:push | yes | yes | no | no | no |
| campaigns:manage | yes | no | no | yes | no |
| campaigns:read | yes | yes | yes | yes | no |
| searches:manage | yes | yes | no | yes | no |
| warm_intro:declare | yes | yes | yes | yes | no |
| analytics:read | yes | yes | yes | yes | yes |
| costs:read, costs:write | yes | yes | no | yes | no |
| budgets:write | yes | yes | no | no | no |
| status:read | yes | yes | yes | yes | yes |
| integrations, members, keys, webhooks, settings, audit | yes | members:read | no | no | no |

These are the **defaults**. Each workspace can change them (below). "Grantable" means an owner can add
it as an extra permission on a membership (review is a permission, not a role). Platform admins have
every permission in every tenant, always audited; they are not a role.

The Viewer role (web-ui Decision 17) sees the pipeline and the scorecard and changes nothing:
`accounts:read`, `offers:read`, `analytics:read`, `status:read`. Its data limit defaults to `all`.

## Editable roles per workspace (web-ui Decision 17)

- A workspace's role sets live in `tenancy.role_permission` (one row per tenant and role, the role's
  permission list). A role with no row uses the default above, so a new workspace needs no seed and a
  later change to the defaults reaches every workspace that never edited that role. A workspace with a
  customised Operator role keeps its saved list, so it does not gain `playbooks:write` until the role is
  restored to the defaults or edited (R2c-2). R3a's new `costs:read` and `budgets:write` are the exception:
  a tenancy migration (`0009_cost_permissions`) adds them to saved Leader and Operator lists (`budgets:write` to
  Leader only) where missing, since no saved list could have unticked a permission that did not exist yet.
- `GET /api/v1/roles` (`members:read`) returns per role its current `permissions`, its
  `default_permissions`, `customised` and `locked` (true for Owner), and the permission list with labels
  and groups. `PUT /api/v1/roles/{role}` (`members:manage`, people only) replaces one role's list.
- **Owner is locked**: it always holds every permission; `PUT /api/v1/roles/owner` is 409
  `role-locked`.
- **No escalation**: someone who is not an owner or platform admin can add or remove only permissions
  they hold themselves (403 `permission-not-yours`, as for extras). Restore defaults is a `PUT` with
  `default_permissions`, under the same rule.
- Saving writes the row, audits `tenancy.role.permissions_changed` with the added and removed
  permissions, and drops the instance's cached principals for the workspace. Members pick the change up
  on their next request (other instances within 60 seconds).
- Effective permissions are the workspace's role set plus the membership's extras. Every check that
  used the role's default set (sign-in principal, member list, "who can be assigned", "can you give
  this role") reads the workspace's set. API keys keep their own scopes.

## Data limits

A data limit says which rows a principal may see. It is stored as JSON on the membership, key or
grant, and turned into a query filter by `dataFilter(principal, resource)`.

| Kind | JSON | Sees |
|---|---|---|
| All | `{ "kind": "all" }` | Everything in the tenant |
| Practices | `{ "kind": "practices", "ids": ["prc_…"] }` | Accounts whose `practice_ids` (owned by Accounts) or whose best offer's practice is in the limit (spec's call, D25) |
| Own accounts | `{ "kind": "own_accounts" }` | Accounts assigned to this user (current or past), and accounts this user submitted |
| Sources | `{ "kind": "sources", "ids": ["src_…"] }` | Accounts and arrivals that came from those sources (and their child sources) |
| Own source | `{ "kind": "own_source" }` | Only arrivals and accounts that the principal's own source sent; the default for agent keys |

Limits can be combined with `{ "kind": "any_of", "limits": [ ... ] }`. Defaults: Owner, Leader,
Operator `all`; Seller `own_accounts`; API key and OAuth grant `own_source`.

An account counts as "sent by" a source if any arrival from that source resolved to it. A source that
sends an account that already exists may then see that account's status, but only the fields its
scopes allow.

## Stories

### TEN-E3-S1 One permission check everywhere
As an owner, I want the same rules applied in the web app, API and MCP, so that access is predictable.
- TEN-E3-S1-AC1 Every service method declares the permission it needs; a principal without it gets
  403 (API), a hidden control (web), or a tool error "This key can't do that. It needs the
  `<permission>` scope." (MCP).
- TEN-E3-S1-AC2 A test suite runs each role and each data limit kind against every list endpoint and
  proves no row outside the limit is returned.

### TEN-E3-S2 Grant review to anyone
As an owner, I want to let a seller or operator review accounts, so that review can be spread out.
- TEN-E3-S2-AC1 Adding `review:act` to a membership makes the review queue appear for that person,
  filtered by their data limit.

### TEN-E3-S3 Hide contact details
As an owner, I want principals without `people:read` to see people's names and roles but not emails
or phones, so that partners can't harvest contacts.
- TEN-E3-S3-AC1 Responses for such principals omit `email`, `phone`, `mobile` and `linkedin_url`.

### TEN-E3-S5 Change what a role can do
As an owner, I want to change a role's permissions for my workspace, so that the roles fit how my team
works.
- TEN-E3-S5-AC1 After saving, a member with that role gets the new set on their next request, in the
  web app, API and MCP.
- TEN-E3-S5-AC2 The Owner role can't be changed, and nobody but an owner or platform admin can add or
  remove a permission they don't hold.
- TEN-E3-S5-AC3 Restore defaults puts a role back to the table above; another workspace is never
  affected.

### TEN-E3-S4 Explain access
As a member, I want to see why I can't see or do something, so that I know whom to ask.
- TEN-E3-S4-AC1 The profile page lists my role, permissions and data limit in plain words.
