# INT-E6 One-click OAuth connections

Release: phase 2 (after R4)

## Why

Pasting tokens works for Phase 1 (D18). Owners at client tenants will expect "Connect HubSpot" to open
the vendor's sign-in and come back connected.

## Rules

- Supported first for HubSpot, Salesforce, Microsoft Dynamics and LinkedIn.
- Scout registers one OAuth app per provider (platform level). Tokens are stored as `oauth_tokens`
  credentials (access and refresh), encrypted as in INT-E2, refreshed by a job before expiry.
- The scopes requested are the minimum the adapter declares.
- Pasted-key connections keep working; an owner can switch a connection to OAuth.

## Stories

### INT-E6-S1 Connect with one click
As an owner, I want to click Connect and approve access in HubSpot, so that I don't create a private
app.
- INT-E6-S1-AC1 After approving, the connection shows Connected with the account name and a passing
  test.

### INT-E6-S2 Token refresh
- INT-E6-S2-AC1 Tokens are refreshed at least 10 minutes before expiry; a refresh failure marks the
  connection failing and notifies owners with a Reconnect button.
