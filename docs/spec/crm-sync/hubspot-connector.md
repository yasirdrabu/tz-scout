# CRM-E2 HubSpot connector setup

Release R1 · Module CRM

## Why

HubSpot is Taazaa's CRM and the first connector. Today it runs with a private app token on one
laptop. In Scout the token is entered per tenant in Integrations, tested, and the custom fields and
owner roster are set up from the app.

## Rules

- Auth: private app token in R1 (stored encrypted by Integrations); OAuth app install in phase 2.
- Scopes needed: companies, contacts, notes, tasks, deals read, owners read, properties write (only
  for field setup), webhooks (optional). The connection test reports which are missing in plain words.
- Custom company properties live in a group named "Scout buyer signals" (renamed from "Taazaa buyer
  signals"; existing `taazaa_*` properties are kept and mapped, not recreated). Defaults: best offer,
  tier, priority score, fit score, buying intent score, why now, top signals, research topics,
  practice, Scout link, last handoff date.
- Properties are created only when an owner presses "Set up HubSpot fields". Until then a push sends
  the note, people and tasks, and skips properties that don't exist.
- Portal id is stored on the connection so "Open in HubSpot" links work.

## Stories

### CRM-E2-S1 Connect HubSpot
As an owner, I want to paste a HubSpot token and test it, so that Scout can hand off to our CRM.
- CRM-E2-S1-AC1 Given a valid token, when I press Test, then Scout shows the portal name, portal id and
  each needed scope as present or missing.
- CRM-E2-S1-AC2 Given a token without owners read, the test passes with a warning "Owner list can't be
  read, so Scout can't name who owns a company" and the roster sync is disabled.
- CRM-E2-S1-AC3 The token is never shown again after saving; only the last 4 characters.

### CRM-E2-S2 Set up HubSpot fields
As an owner, I want Scout to create its fields in HubSpot once, so that reps can filter companies by
tier and offer.
- CRM-E2-S2-AC1 Pressing "Set up HubSpot fields" creates the group and any missing properties, and lists
  what it created. Running it again creates nothing new.
- CRM-E2-S2-AC2 Existing v1 `taazaa_*` properties are recognised and mapped (CRM-E7).

### CRM-E2-S3 Owner roster
As a leader, I want Scout to know every HubSpot owner, active and former, so that it can say who owns
a company today and assign to the right rep.
- CRM-E2-S3-AC1 "Sync owners" loads every owner with name, email and active flag into `crm.owner`.
- CRM-E2-S3-AC2 Owners whose email matches a Scout user are offered as a match in Settings → Team;
  confirming writes `{ hubspot: "<owner id>" }` into that membership's `crm_owner_ids` (TEN).
- CRM-E2-S3-AC3 A seller can only be assigned (in Review and routing) if `crmOwnerId(ctx, userId,
  "hubspot")` returns an active owner; otherwise the assign dialog says "Link this person to a HubSpot
  owner first".
- CRM-E2-S3-AC4 The roster refreshes daily and on demand.
