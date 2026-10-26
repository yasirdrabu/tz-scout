# TEN-E2 Microsoft sign-in

Release R0

## Why

Taazaa's team signs in with Microsoft 365. Only people added as members get in, even with a valid
Taazaa account (carried from HANDOFF.md).

## Rules

- Sign-in uses Microsoft Entra ID through better-auth (OpenID Connect, scopes `openid profile email
  User.Read`). Settings: `AZURE_AD_TENANT_ID`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`.
- Multi-tenant Entra apps are allowed so client tenants (Tobi) can sign in with their own Microsoft
  accounts; access is still decided by Scout membership, never by the Entra tenant.
- A matching user is found by Entra object id, then by email (or UPN) on first sign-in.
- Developer sign-in (pick a seeded user, no password) exists only when `AUTH_DEV_SIGNIN=true`; the app
  refuses to start with it on when `NODE_ENV=production`.
- Sessions last 12 hours of inactivity, 7 days at most.

## Stories

### TEN-E2-S1 Sign in with Microsoft
As a member, I want to sign in with my Microsoft account, so that I don't manage another password.
- TEN-E2-S1-AC1 Given my email is a member of at least one tenant, when I sign in, then I land on my
  last used tenant.
- TEN-E2-S1-AC2 Given my email is not a member anywhere, when I sign in, then I see "Your account
  isn't set up in Scout yet. Ask your Scout owner to add you." and no session is created.
- TEN-E2-S1-AC3 An invited member becomes active on first successful sign-in.

### TEN-E2-S2 Developer sign-in for local use
As a developer, I want to sign in as a seeded user without Microsoft, so that Scout runs on mocks.
- TEN-E2-S2-AC1 Shown only when `AUTH_DEV_SIGNIN=true`.
- TEN-E2-S2-AC2 Startup fails with a clear message if `AUTH_DEV_SIGNIN=true` and `NODE_ENV=production`.

### TEN-E2-S3 Disabled users
As a platform admin, I want to disable a user everywhere, so that someone who leaves loses access at
once.
- TEN-E2-S3-AC1 A disabled user cannot sign in, and their open sessions end within one minute.
- TEN-E2-S3-AC2 API keys they created stay valid (keys belong to the tenant) but show "Creator
  disabled" so an owner can review them. OAuth grants they consented to are revoked.
