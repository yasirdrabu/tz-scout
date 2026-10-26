# ACC-E2 Buying committee

Status: Draft · Release: R2

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
- **Guessing from title** (pure, unit tested): chief or VP of a business function → `business_owner`;
  CFO, owner, president, CEO → `commercial_buyer`; CIO, CTO, IT, engineering, security, data titles →
  `technical_buyer`; procurement, purchasing, contracts → `procurement`. Only applied when the source
  stated no roles.
- **Target roles per offer** come from OFF: each offer lists required and optional buying roles and
  target titles (for example, Modernization Blueprint: required business owner, technical buyer,
  commercial buyer; optional procurement).
- **Coverage** for an account and an offer: for each target role, the people holding it, and a status:
  `covered` (at least one person with a stated or confirmed role), `guessed` (only guessed), `gap`.
  Plus an overall line: "3 of 4 roles covered".
- **Filling a gap**: "Find" on a gap opens an enrichment request (ENR) for that role's target titles;
  the person picks the provider (Apollo people search, or "ask an agent" which records a flag the
  agent can see through its feedback). When an account has no people at all, the gap reads "No people
  yet" with the same choice.

## Stories

### ACC-E2-S1 See coverage and gaps
As a leader, I want the account page to show the buying committee against what the offer needs, so
that I know whether the account is ready to assign.
- ACC-E2-S1-AC1 For the account's best offer (or a chosen offer), each target role shows the people
  holding it and a status chip: covered, guessed, gap.
- ACC-E2-S1-AC2 `getCommittee(accountId, offerId)` and the committee part of `get_account_brief` (PLB) return the
  same structure.
- ACC-E2-S1-AC3 Unit tests for role guessing from 20 sample titles, including "Chief of Paratransit
  Operations & Mobility Services" → business owner and "Contracts Manager" → procurement.

### ACC-E2-S2 Set roles and notes
As an AE, I want to set each person's roles and add a note on where they stand, so that the team
shares one picture of the committee.
- ACC-E2-S2-AC1 A person can add or remove roles on anyone; changes are facts with the editor as
  source and publish `accounts.person.updated`.
- ACC-E2-S2-AC2 A decision note (up to 1,000 characters) is kept per person with who wrote it and when.

### ACC-E2-S3 Fill a gap
As a leader, I want to fill a committee gap by choosing where to look, so that we only spend credits
when I decide to.
- ACC-E2-S3-AC1 "Find" on a gap creates an ENR request of kind `people_for_roles` with the role and the
  offer's titles, showing the credit estimate before the person confirms (ENR-E1).
- ACC-E2-S3-AC2 When the request completes, new people appear with roles guessed from title and the
  gap updates.
