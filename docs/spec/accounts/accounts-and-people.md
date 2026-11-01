# ACC-E1 Accounts and people

Status: Draft · Release: R1

## Why

Everything Scout does hangs off a company and the people in it (D2). The model must hold today's
Apollo, Vibe and research-sheet data, a buyer's roles in the decision, and a sole proprietor without
special cases elsewhere.

## Rules

- **Account** fields are listed in the index. `domain` is unique per tenant among active accounts
  (other domains go in `account_alias`). Display name keeps legal suffixes.
- **Shell account** for a sole proprietor: name "<First Last>", `is_shell = true`, domain from the
  person's own website if given, else none. The person gets roles `business_owner` and
  `commercial_buyer`. Shell accounts match on the person's email (SRC-E3).
- **Person** belongs to one account. Email unique per account among active people. `email_status`:
  `verified`, `unverified`, `catch_all` (shown as "Can't be verified"), `invalid`.
- **Seniority** is derived from the title (today's rules: owner, founder, chief, president, VP, head,
  director, manager, other) unless a source states it.
- **Primary person** (who to approach first), carried from today's `pickPrimary`: a person whose
  title matches the best offer's target titles, then higher seniority, then a verified email. A person
  can pin a different primary; the pin wins until removed. Recomputed on `scoring.account.scored`
  (best offer may change) and on person changes.
- **People from outside** come through intake: `upsertFromArrival` matches a person by email, then
  LinkedIn URL, then same first and last name at the account; otherwise adds them. Today's rule
  carries: published emails in a research sheet are matched to the right person by name.
- **Editing in the web app**: people with `accounts:write` can edit account and person fields. Each edit
  is a fact with source = the editor's person source and status `current`, pinned (ACC-E3).
- Archiving an account hides it from lists and search; nothing is deleted (data conventions).

## Stories

### ACC-E1-S1 Create and update from arrivals
As the intake pipeline, I want one call that creates or updates an account with its people, facts and
signals, so that every source is handled the same way.
- ACC-E1-S1-AC1 `upsertFromArrival` with a new domain creates the account, its people, facts and
  signals in one transaction and publishes `accounts.account.created` plus one `person.added`,
  `fact.recorded`, `signal.recorded` per item.
- ACC-E1-S1-AC2 With an existing account id it adds only what is new: a person with an existing email
  is updated, not duplicated; a repeated signal is not stored twice (ACC-E4).
- ACC-E1-S1-AC3 Every created row carries the arrival id and source chain.

### ACC-E1-S2 Shell accounts for sole proprietors
As an operator, I want a one-person business to be an account like any other, so that the rest of
Scout doesn't need special cases.
- ACC-E1-S2-AC1 An arrival with `sole_proprietor: true`, a person and no company creates a shell
  account named after the person, with the two owner roles.
- ACC-E1-S2-AC2 A second arrival with the same email attaches to the same shell account.
- ACC-E1-S2-AC3 A person can convert a shell account into a normal one by giving it a company name and
  domain; history is kept.

### ACC-E1-S3 People and primary contact
As an AE, I want to see who works there, their role in the decision and who to approach first, so
that I start with the right person.
- ACC-E1-S3-AC1 The account page lists people with title, roles, email and its status, phone, LinkedIn
  and decision note; primary is marked "Approach first".
- ACC-E1-S3-AC2 Unit test for the primary rule: target title beats seniority, seniority beats a
  verified email; a pinned primary wins.
- ACC-E1-S3-AC3 Changing the best offer re-picks the primary unless pinned.

### ACC-E1-S4 Agents add people
As an agent, I want to add a person I found to an account, so that the committee fills out.
- ACC-E1-S4-AC1 `add_person(account_id, person)` and `POST /api/v1/accounts/{id}/people` submit an inline
  targeted arrival through SRC and return `person_id` in the same call, with the agent as source.
- ACC-E1-S4-AC2 A person matching an existing one (same email, or same name at the account) returns
  the existing `person_id` with `already_known: true`; any new values are recorded as facts.
- ACC-E1-S4-AC3 The response includes the account's remaining committee gaps for its best offer.
- ACC-E1-S4-AC4 An agent without visibility of the account gets "not found".

## MCP tools

`add_person`, as defined in [mcp/agent-tools.md](../mcp/agent-tools.md): input `account_id` and a
`PersonInput` (`name`, `title`, `buying_role`, `email`, `phone`, `linkedin_url`, `notes`); output
`person_id`, `summary`, `committee_gaps`, and `already_known` when it matched.
