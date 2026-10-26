# TEN-E1 Tenants and memberships

Release R0

## Why

Scout serves Taazaa first and clients later (D20). Every row belongs to one tenant, and a person can
belong to more than one tenant (a Taazaa platform admin helping Tobi).

## Rules

- Tenants are created only by a platform admin. There is no self-signup.
- A tenant has a slug used in URLs (`/t/taazaa/...`), a currency and a timezone. Currency and
  timezone can change only while the tenant has no cost lines.
- A user is one person, identified by email. Memberships connect users to tenants with one role.
- A person with memberships in several tenants picks the tenant with a switcher; the URL carries the
  tenant slug, so links are unambiguous.
- Removing a member keeps their history (assignments, edits) with their name; they lose access at
  once and their open sessions end.
- A tenant always has at least one active Owner.

## Stories

### TEN-E1-S1 Create a tenant
As a platform admin, I want to create a tenant with its first owner, so that a new company can start
using Scout.
- TEN-E1-S1-AC1 Given a slug, name, currency, timezone and owner email, when I create the tenant, then
  the tenant exists, the owner has an invite, and default settings (review statuses, buying roles,
  decline reasons) are seeded.
- TEN-E1-S1-AC2 A slug already in use is refused with "That short name is taken."
- TEN-E1-S1-AC3 Creating a tenant is written to the platform audit log, not the tenant's.

### TEN-E1-S2 Add and remove members
As an owner, I want to add people with a role and remove them, so that the right people have access.
- TEN-E1-S2-AC1 Given an email and a role, when I add a member, then an invite is sent and the person
  appears as "Invited" until they sign in.
- TEN-E1-S2-AC2 When I remove a member, then their sessions end within one minute and
  `tenancy.member.removed` is published.
- TEN-E1-S2-AC3 Removing or demoting the last Owner is refused.

### TEN-E1-S3 Change a member's role and data limit
As an owner, I want to change someone's role, extra permissions and data limit, so that access matches
their job.
- TEN-E1-S3-AC1 A change applies on the person's next request without signing out.
- TEN-E1-S3-AC2 `tenancy.member.role_changed` is published and the audit log shows before and after.

### TEN-E1-S4 Map members to CRM owners
As an owner, I want to link each seller to their CRM user, so that handoffs set the right owner.
- TEN-E1-S4-AC1 Each membership stores a CRM owner id per CRM (`{ hubspot: "123" }`).
- TEN-E1-S4-AC2 When the HubSpot connection can read owners, the settings page suggests matches by
  email; a person confirms each match.
- TEN-E1-S4-AC3 A seller membership can be created in status `invited` with `crm_owner_ids` already
  set, before the person first signs in; such a member can be picked in the assign list and receives
  handoffs (needed by the v1 data migration for Ash, Mike and Andy).
- TEN-E1-S4-AC4 `userForCrmOwner(ctx, crm, ownerId)` returns the user whose membership holds that CRM
  owner id (active or invited), or null; two memberships in one tenant cannot hold the same owner id
  for the same CRM (refused with "That CRM user is already linked to someone else.").

### TEN-E1-S5 Switch tenant
As a person in more than one tenant, I want to switch tenants from the header, so that I can work in
each without signing out.
- TEN-E1-S5-AC1 The switcher lists only tenants where my membership is active.
- TEN-E1-S5-AC2 Platform admins see every tenant and every view they open is marked "Support access"
  and audited.
