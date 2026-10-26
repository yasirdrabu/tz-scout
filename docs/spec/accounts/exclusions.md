# ACC-E7 Exclusions

Status: Draft · Release: R1

## Why

Some companies shouldn't be sold to as new business: software vendors who compete with us, units of
larger parents we already work with, existing customers and companies with an open deal. Today Scout
rules these out ("8 ruled out: five software vendors, three units of larger parents"). They are still
stored, marked, and a person can override.

## Rules

- **Exclusion rules** (tenant-configurable, defaults on):

  | Key | Label | How it's decided |
  |---|---|---|
  | `software_vendor` | Software vendor | industry key or keywords in a configured list (today's list) |
  | `unit_of_parent` | Part of a larger company | `parent_domain` fact set and the parent matches a configured list or is itself excluded |
  | `existing_customer` | Already a customer | `crm_status = customer` |
  | `open_deal` | Has an open deal | `crm_status = open_deal` |
  | `domain_listed` | On our do-not-contact list | domain in the tenant's list |

- `crm_status` (`none`, `open_deal`, `customer`) is a projection ACC keeps from `crm.deal.changed` and
  `crm.handoff.completed` (which carries the CRM company's lifecycle). ACC never calls CRM directly.
- Exclusions are checked on every upsert and every change to the inputs. The first matching rule sets
  `excluded_reason_key`. Excluded accounts are scored "not a fit" by SCO, stay searchable, and show
  "Ruled out: <label>".
- A person with `accounts:write` can override with a note ("Sell anyway"); the override stays until
  removed and publishes `accounts.account.exclusion_changed`.

## Stories

### ACC-E7-S1 Rule out accounts
As a leader, I want companies we shouldn't sell to marked automatically, so that reps don't waste time
or step on existing relationships.
- ACC-E7-S1-AC1 Unit tests for each default rule with today's fixtures (five software vendors and three
  units of larger parents from the first Vibe pull).
- ACC-E7-S1-AC2 A `crm.deal.changed` to open marks the account `open_deal` when it is
  processed; in R1 deals arrive by the hourly deal poll, so within an hour of the deal opening (D28,
  D32).

### ACC-E7-S2 Override
As a leader, I want to override an exclusion with a reason, so that a real opportunity isn't blocked
by a rule.
- ACC-E7-S2-AC1 Override requires a note, is audited, and triggers a rescore.
- ACC-E7-S2-AC2 Settings, Exclusions lets owners turn rules on or off and edit the vendor keyword list
  and do-not-contact domains.
