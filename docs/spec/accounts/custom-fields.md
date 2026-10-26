# ACC-E6 Custom fields per practice

Status: Draft · Release: R2

## Why

Each practice cares about different things. The ABM brief for a transit agency shows "Fleet tier" and
"ABM motion"; a data practice may want "Data platform" or "Cloud". These are defined per tenant and
practice in Settings, not built into the model.

## Rules

- A custom field definition: `key` (stable, lowercase), `label`, `type` (`text`, `number`, `money`,
  `select`, `multi_select`, `date`, `boolean`, `url`), `options` (for selects: key and label),
  `practice_ids` (empty means every practice), `show_in_brief` (appears in the brief's score strip),
  `sort`.
- Values are facts of kind `custom`, so provenance, conflicts (selects compare keys; numbers and money
  use the money/count tolerances) and history apply.
- Arrivals send them in `account.custom_fields` by key; unknown keys are kept in the raw payload.
- Seeded examples for Taazaa's AI Operating Platforms practice: `fleet_tier` (select: verified,
  unverified, none), `abm_motion` (select: tier 1 one-to-one, tier 2 one-to-few, tier 3
  one-to-many), `revenue_potential` (select: low, medium, high).
- Deleting a definition archives it; values stay in history.

## Stories

### ACC-E6-S1 Define custom fields
As an owner, I want to add fields that matter to a practice, so that briefs carry the details our
sellers need.
- ACC-E6-S1-AC1 Settings, Custom fields lets owners add, edit, reorder and archive definitions, scoped
  to practices.
- ACC-E6-S1-AC2 A field marked "show in brief" appears in the brief's score strip for accounts whose
  best offer is in one of its practices.

### ACC-E6-S2 Fill custom fields
As a leader, I want to set custom values on an account or receive them from sources, so that the brief
is complete.
- ACC-E6-S2-AC1 The account page shows the practice's custom fields with values, sources and an edit
  control per type.
- ACC-E6-S2-AC2 An arrival with `custom_fields.abm_motion = "tier_1_one_to_one"` sets the value with
  the arrival's source as provenance; a value not in the options is kept in raw and reported as unused.
