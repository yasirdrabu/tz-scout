# TEN: Tenancy and access

Module code TEN · Schema `tenancy` · Releases R0 (core), R1 (keys and OAuth), R4 (partner invites)

## Purpose

Decide who is asking and what they may see and do. Every request, from a person in the web app, an
API key or an MCP client, is turned into one **principal** with a tenant, a set of permissions and a
data limit. Every other module trusts this and nothing else.

## Owns

| Table | Key fields |
|---|---|
| `tenant` | `id` (`t_`), `slug`, `name`, `currency` (ISO 4217), `timezone`, `status` (active, suspended), `created_at` |
| `user` | `id` (`usr_`), `email` (unique, lower case), `name`, `entra_object_id`, `platform_admin` (bool), `last_sign_in_at`, `disabled_at` |
| `membership` | `id`, `tenant_id`, `user_id`, `role` (owner, leader, seller, operator), `extra_permissions[]`, `data_limit` (json, see roles-and-data-scopes.md), `crm_owner_ids` (json: `{ hubspot: "123" }`), `invited_by`, `status` (invited, active, removed) |
| `invite` | `id`, `tenant_id`, `email`, `role`, `kind` (member, partner), `token_hash`, `expires_at`, `accepted_at` |
| `api_key` | `id` (`key_`), `tenant_id`, `name`, `prefix` (first 12 chars, shown), `secret_hash` (argon2id), `environment` (live, test), `scopes[]`, `data_limit` (json), `source_id` (the source this key submits as; required if it has `arrivals:write`), `rate_limit_per_minute`, `daily_arrival_cap`, `monthly_enrichment_credit_cap`, `created_by`, `expires_at`, `last_used_at`, `last_used_ip`, `revoked_at` |
| `oauth_client` | `id`, `tenant_id` (null for dynamically registered before consent), `client_id`, `name`, `redirect_uris[]`, `kind` (registered, dynamic), `created_by`, `disabled_at` |
| `oauth_grant` | `id`, `tenant_id`, `client_id`, `user_id` (who consented), `scopes[]`, `data_limit`, `source_id`, `refresh_token_hash`, `expires_at`, `revoked_at`, `last_used_at` |
| `session` | managed by better-auth |

Sessions, password-less sign-in and OAuth token issuance are delegated to better-auth; the tables
above are the parts the spec cares about.

## Depends on

Nothing synchronous. Reads `intake.source` ids only as opaque ids. A key's `source_id` is validated
through `SourceValidator.exists(ctx, id)`, an interface TEN defines in `tenancy/contracts` and SRC
implements; the composition root wires it, so TEN never imports SRC (spec's call, D29).

## Epics

| Epic | File | Release |
|---|---|---|
| TEN-E1 Tenants and memberships | [tenants-and-memberships.md](tenants-and-memberships.md) | R0 |
| TEN-E2 Microsoft sign-in | [microsoft-sign-in.md](microsoft-sign-in.md) | R0 |
| TEN-E3 Roles, permissions and data scopes | [roles-and-data-scopes.md](roles-and-data-scopes.md) | R0 |
| TEN-E4 API keys and OAuth clients | [api-keys-and-oauth-clients.md](api-keys-and-oauth-clients.md) | R1 |
| TEN-E5 Partner invites | [partner-invites.md](partner-invites.md) | R4 |

## Public interface (for other modules)

- `resolvePrincipal(request) → Principal` (`{ tenantId, kind: user|api_key|oauth, id, userId?, sourceId?, permissions[], dataLimit }`)
- `can(principal, permission) → boolean`
- `dataFilter(principal, resource) → filter` (the predicate a module applies to its queries)
- `members(ctx, { permission? }) → Member[]` (for seller pickers, review queues)
- `crmOwnerId(ctx, userId, crm) → string | null`
- `userForCrmOwner(ctx, crm, ownerId) → userId | null` (reverse lookup, used by CRM to set the acting
  seller on `crm.activity.observed`; covers invited members, see TEN-E1-S4-AC3 and AC4)

## Events

| Event | Data |
|---|---|
| `tenancy.member.added` | `userId`, `role`, `invitedBy` |
| `tenancy.member.removed` | `userId`, `removedBy` |
| `tenancy.member.role_changed` | `userId`, `from`, `to` |
| `tenancy.api_key.created` | `keyId`, `name`, `scopes`, `sourceId`, `environment` |
| `tenancy.api_key.revoked` | `keyId`, `revokedBy`, `reason` |
| `tenancy.oauth_grant.created` / `.revoked` | `grantId`, `clientId`, `userId`, `scopes` |

Consumes nothing.

## API endpoints

| Method and path | Scope | Notes |
|---|---|---|
| `GET /v1/me` | any | The calling principal: tenant, kind, scopes, data limit, source |
| `GET /v1/members` | `members:read` | Members with role and permissions (no emails for agents without `people:read`) |
| `GET /v1/api-keys` | `keys:manage` | Keys of the tenant, never the secret |
| `POST /v1/api-keys` | `keys:manage` | Returns the secret once |
| `POST /v1/api-keys/{id}:rotate` | `keys:manage` | New secret; old one valid for a grace period |
| `POST /v1/api-keys/{id}:revoke` | `keys:manage` | |

Member and key management for people happens in the web app; the API exists so automation can do it.

## MCP tools

None of its own. Every tool resolves its principal here. `GET /v1/me` is exposed to agents through
the `whoami` resource in the MCP server (see mcp/).

## Open questions

- Should a person be able to hold different roles in different practices of one tenant (e.g. Leader
  for AI Transformation, Seller elsewhere)? Spec's call for now: one role per tenant, practices limit
  data through the data limit.
- Restricting sign-in by Entra group instead of by member list: not needed for Taazaa's team size.
