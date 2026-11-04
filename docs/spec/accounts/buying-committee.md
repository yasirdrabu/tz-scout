# ACC-E2 Buying committee

Status: Shipped in R2b-3 (plan `docs/plans/2026-11-03-r2b-3-committee.md`) · Release: R2

## Why

ABM sells to a group, not a person. The account page must show who we have for each role the offer
needs and where the gaps are ("we have the business owner but no one in IT or security"), and let a
person fill a gap by choosing where to look (answer B6).

## Rules

- **Buying roles** (tenant-configurable list, defaults): `commercial_buyer` (signs and owns budget),
  `technical_buyer` (judges fit, IT or engineering), `business_owner` (owns the problem day to day),
  `influencer`, `procurement`, `champion` (actively for us), `blocker` (actively against), `user`.
- A person can hold several roles. Each role assignment has an origin: `stated` (the source said so),
  `guessed_from_title`, or `set_by_person`. Guessed roles show as "Guessed from title" until a person
  confirms or removes them.
- **Guessing from title** (pure, `guessRolesFromTitle`, unit tested): matched case-insensitively on word
  boundaries, after `&` and `,` are read as spaces. `commercial_buyer`: CFO, chief financial, owner,
  president, CEO, chief executive, finance director, controller. `technical_buyer`: CIO, CTO, CISO, chief
  information, chief technology, IT, information technology, engineering, security, data, technology,
  infrastructure. `procurement`: procurement, purchasing, contracts, buyer, sourcing. `business_owner`:
  any title with `chief `, `vp`, `vice president`, `head of` or `director`, only when no rule above
  matched. A title can give several roles ("CTO" gives only `technical_buyer`). Known cost: "it" is
  case-insensitive, so a rare title can give a false technical buyer guess.
- **When guesses apply** (`matchOrAddPerson`): stated roles are stored as `stated`, and a stated role
  upgrades a stored `guessed_from_title` row of the same key. Guesses are used only when the arrival
  states no roles and the person has no stored roles. They are the union of the source's guessed roles
  (Enrich) and the title guess, kept for the tenant's active buying roles, and stored as
  `guessed_from_title`. A stated role does not wipe other guesses.
- **No backfill (parked):** people who already have no roles get guesses on their next arrival. A one-off
  backfill is parked. A person with no roles left after a removal gets guesses again on the next
  arrival (parked).
- **Target roles per offer** come from OFF: `target_buying_roles` is the **required** list and
  `optional_buying_roles` the optional one (seeded offers: required business owner, technical buyer,
  commercial buyer; optional procurement). Scoring still reads only the required list.
- **Coverage** (pure, `coverage`): the roles are the offer's required ones, then its optional ones, in
  buying-role sort order; archived roles are dropped. With no offer, or an offer with no active required
  roles, the required roles are the core three (`business_owner`, `commercial_buyer`,
  `technical_buyer`) and there are no optional ones. Status: `covered` (a person holds the role as
  `stated` or `set_by_person`), `guessed` (only `guessed_from_title`), `gap`. The summary counts required
  roles only: "{covered} of {required} roles covered" ("1 of 1 role covered"). Optional gaps show as
  "No {label} yet · Optional" with `Find`, are not counted and are not in the checklist. A guessed role
  does not count until confirmed.
- **Committee shape:** `getCommittee(ctx, accountId, offerId?)` returns `{offer: {id, name} | null,
  roles: [{key, label, required, status, people: [{id, name, title, origin}]}], summary: {covered,
  required, text}, gaps}` where `gaps` is the required gap keys. The offer is `offerId` when given (404
  when unknown; draft offers are accepted, parked), else the account's lead offer override or best offer.
  `GET /api/v1/accounts/{id}/committee?offer_id=` (`accounts:read`) returns it in snake_case, and
  `GET /api/v1/accounts/{id}/brief` adds `committee` with the same structure. The brief service
  (`getBrief`) does not include it: the future MCP tool must call `getCommittee`.
- **Confirm and edit:** `PATCH /api/v1/people/{id}` takes `role_keys`, `decision_note` and
  `confirm_role_keys`. Each confirmed key must be among the person's roles after the patch (400 "Only a
  role the person holds can be confirmed."); it becomes `set_by_person` with who and when
  (`roles[].set_by_name`, `set_at`). Confirming publishes `accounts.person.updated` (`changedKeys`
  includes `roles`). An edit that only removes roles leaves the other guesses as they were. Archived
  roles already stored on a person stay editable.
- **Decision note:** at most 1,000 characters (400 "Keep the note under 1,000 characters."), also on
  add person (people only; notes from source arrivals stay unlimited, parked). `PersonView` carries
  `decision_note_by` and `decision_note_at` (null when a source wrote it). Clearing a note returns `""`,
  not null, and the page hides it.
- **Filling a gap**: "Find" on a gap opens the Enrich dialog with that role picked (`initialRoles`),
  showing the credit estimate before the person confirms (ENR-E1). People Enrich finds carry the searched
  role as a **guess** (`guessed_buying_roles`), not a stated role, so the row becomes "guessed" until
  someone confirms it. With no people at all the page shows "No people yet" and `Find with Enrich` (the
  required roles only; optional gaps are hidden there, so optional `Find` is unreachable until someone is
  added). Without `enrichment:request` gap rows show with no button.
- **"Ask an agent" is deferred until the MCP server exists.** The agent-flag option of the original
  design is not part of R2b-3; Find opens only the Enrich dialog.

## Stories

### ACC-E2-S1 See coverage and gaps
As a leader, I want the account page to show the buying committee against what the offer needs, so
that I know whether the account is ready to assign.
- ACC-E2-S1-AC1 For the account's best offer (or a chosen offer), each target role shows the people
  holding it and a status chip: covered, guessed, gap.
- ACC-E2-S1-AC2 `getCommittee(accountId, offerId)` and the committee part of the brief read (PLB) return the
  same structure. Shipped over REST (`/committee`, `/brief`); the `get_account_brief` MCP tool waits for the server.
- ACC-E2-S1-AC3 Unit tests for role guessing from 20 sample titles, including "Chief of Paratransit
  Operations & Mobility Services" → business owner and "Contracts Manager" → procurement.

### ACC-E2-S2 Set roles and notes
As an AE, I want to set each person's roles and add a note on where they stand, so that the team
shares one picture of the committee.
- ACC-E2-S2-AC1 A person can add, remove or confirm roles on anyone (`people:write`); changes are facts with the editor as
  source and publish `accounts.person.updated`.
- ACC-E2-S2-AC2 A decision note (up to 1,000 characters) is kept per person with who wrote it and when.

### ACC-E2-S3 Fill a gap
As a leader, I want to fill a committee gap by choosing where to look, so that we only spend credits
when I decide to.
- ACC-E2-S3-AC1 "Find" on a gap opens the Enrich dialog (kind `people_for_roles`) with the role picked,
  showing the credit estimate before the person confirms (ENR-E1). Divergence: the offer's titles are not
  sent; the role is.
- ACC-E2-S3-AC2 When the request completes, new people appear with guessed roles ("Guessed from title") and the
  committee refreshes with no reload. A guessed role is no longer a gap row but counts in the summary
  only after Confirm.
