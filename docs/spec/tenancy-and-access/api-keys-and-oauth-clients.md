# TEN-E4 API keys and OAuth clients

Release R1

## Why

Internal AEs' agents, vendors and partners send accounts and check on them (D8). Each needs its own
credential, limited to its tenant, its source and the permissions it needs, with its own limits, so
one noisy agent can't flood reps or spend credits.

## Rules

- **API keys** look like `scout_live_<12 char prefix>_<32 char secret>` or `scout_test_…`. The full
  key is shown once at creation. Only the prefix is stored readable; the secret is stored as an
  argon2id hash.
- A key belongs to the tenant, not the person who made it. Fields: name, environment, scopes, data
  limit, source, rate limit per minute (default 600), daily arrival cap (default 500), monthly
  enrichment credit cap (default 0, meaning it can flag but not trigger spend), expiry (optional).
- A key with `arrivals:write` must have a source. The source is the agent or vendor in the
  person → agent → vendor hierarchy (see sources-and-intake). Everything the key submits is recorded
  as coming from that source.
- **Test keys** (`scout_test_`) work only against the tenant's sandbox (see public-api/sandbox) and
  never reach a live CRM or spend live credits.
- **Rotation:** a rotated key gets a new secret; the old secret keeps working for 24 hours (owner can
  choose 0 to 7 days), then stops.
- **OAuth 2.1** is used by hosted MCP clients (Claude, ChatGPT). Authorization code with PKCE.
  Dynamic client registration is allowed when the tenant setting "Let AI apps connect themselves" is
  on (default on for Taazaa). On the consent screen the signed-in member picks which source the
  connection submits as and confirms the scopes; scopes can't exceed the member's own permissions,
  and the data limit can't exceed theirs.
- Access tokens last 1 hour; refresh tokens 30 days, rotated on use.
- `last_used_at` and `last_used_ip` update at most once a minute per key.
- Usage caps are enforced by integrations (INT-E4); the key stores its caps.

## Stories

### TEN-E4-S1 Create an API key
As an owner, I want to create a key for an agent with exactly the access it needs, so that I can hand
it to the agent's builder safely.
- TEN-E4-S1-AC1 The form asks for name, environment, source (pick or create), scopes (presets: "Send
  accounts and check status", "Read only", "Custom"), data limit, rate limit, daily cap, credit cap,
  expiry.
- TEN-E4-S1-AC2 The full key is shown once with a copy button and the line "Copy this now. You won't
  see it again."
- TEN-E4-S1-AC3 The preset "Send accounts and check status" grants `arrivals:write`, `arrivals:read`,
  `status:read`, `signals:write`, `people:write`, `enrichment:request`, `offers:read` with data limit
  `own_source`.
- TEN-E4-S1-AC4 `tenancy.api_key.created` is published (without the secret).

### TEN-E4-S2 See and manage keys
As an owner, I want a list of keys with last use, so that I can spot unused or misbehaving ones.
- TEN-E4-S2-AC1 The list shows name, prefix, source, scopes summary, environment, created by, last
  used (relative time and IP), arrivals today against cap, status.
- TEN-E4-S2-AC2 Each key links to its call log (INT-E3) filtered to that key.

### TEN-E4-S3 Rotate and revoke
As an owner, I want to rotate or revoke a key, so that a leaked key stops working.
- TEN-E4-S3-AC1 Revoke takes effect within 60 seconds on every web instance.
- TEN-E4-S3-AC2 A request with a revoked key gets 401 with `type` ending `/key-revoked`.
- TEN-E4-S3-AC3 Rotate returns the new key once; the old one works until the grace period ends.

### TEN-E4-S4 Connect an AI app with OAuth
As a member, I want to connect Claude or ChatGPT to Scout by signing in, so that I don't paste keys.
- TEN-E4-S4-AC1 Given the hosted MCP URL, when the AI app starts the OAuth flow, then I sign in with
  Microsoft, pick a source ("Yasir's research agent" or create one under me) and confirm scopes.
- TEN-E4-S4-AC2 Requested scopes beyond my own permissions are shown as "Not available to you" and not
  granted.
- TEN-E4-S4-AC3 My connected apps are listed on my profile with last use and a Disconnect button;
  owners see all grants in the tenant.

### TEN-E4-S5 Expiry reminders
As an owner, I want warning before a key or grant expires, so that agents don't break silently.
- TEN-E4-S5-AC1 Owners get an in-app and email notice 7 days and 1 day before a key expires.
