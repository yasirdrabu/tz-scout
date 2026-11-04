# PLB-E1 Playbook templates

Release R2 · API and data shipped in R2c-1 · screens in R2c-2 · stop rule enforced in R2c-3

## Why

ABM works when the same motion is run deliberately and improved. A template captures how an offer is
sold: the steps, on which day, through which channel, by whom, to which buying role, and the draft
or guidance a rep needs. The Miami-Dade DTPW one-pager is an example of a "public sector RFP"
motion: register as a vendor, brief the business owner, request an industry day via the contracts
manager, show up at the state conference, team with the operator.

Decision 25 and the user's answers of 2026-11-02 and 2026-11-04 replaced the older model (weeks,
nine step types, scope per practice or offer, motion, suggestion by practice). The mockup's model
wins: each offer picks a playbook per tier, steps are by day, and a playbook has a stop rule.

## Rules

- **Drafts only (user, 2026-11-02).** No step sends anything. An email step holds a drafted subject
  and body that the seller sends. There is no auto-send mode or field.
- **Which playbook runs.** A template is not tied to a practice or offer. Each offer maps a tier to a
  template (`offer_playbook`, below). The tiers that may be mapped are `act_now`, `good_fit` and
  `watch`; Nurture and Not a fit never have a row. The choice order when an assignment is accepted
  is in PLB-E2.
- **Fields.** `name` (required, "Give the playbook a name."), `description`, `when_to_use`, `status`
  (`draft`, `active`, `archived`), `stop_when`, `version` (starts at 1), `updated_by`, `updated_at`.
- **Who.** Reading needs `playbooks:read`. Creating, editing, duplicating, archiving and deleting
  need `playbooks:manage`.
- **Stop rule (user, 2026-11-02).** `stop_when` is `reply_or_meeting` (default), `meeting` or
  `never`. It is stored on the template and copied onto each plan. R2c-1 stores it; R2c-3 acts on it
  (a reply or meeting stops the plan, status `stopped`).
- **Versioning.** Saving an `active` or `archived` template with any change to its steps bumps
  `version` and writes the new step set under the new version; the old rows stay and are readable
  with `?version=`. A `draft` template has its steps replaced in place. Saving the same steps again
  changes nothing. Name, description, when-to-use, stop rule and status edits never bump the
  version. Plans keep the version they started with and read `newer_version: true` once the
  template has moved on.
- **Activating.** A template needs at least one step before it can be `active`, otherwise 400 "Add
  at least one step."
- **Duplicate.** Copies the template (current version's steps) as a draft named "{name} (copy)".
- **Archive.** The template stops being chosen. Running plans are untouched. Archiving deletes the
  template's `offer_playbook` rows in the same transaction, so each of those offer tiers reads "no
  playbook" (the Retire confirm says "It will be removed from {n} offer tiers"; R2c-2). A retired offer's
  tiers cannot be changed: 409 "This offer is retired."
- **Delete.** Allowed only when no plan ever used the template and no `offer_playbook` row points at
  it. Otherwise 409 "This playbook has run on accounts. Retire it instead." Delete removes the
  template's steps first.
- **Steps.**
  - `order` (renumbered 1 to n), `day` (integer 0 to 365; day 0 is the start day; screens show it 1-based, "Day 1" to "Day 366", and "{n} steps over {d} days" counts the last day + 1), `channel`,
    `owner_role` (`seller`, `leader` or `operator`), `title` (required, up to 200 characters),
    `detail` (markdown guidance, up to 4,000), `target_buying_roles` (buying-role keys; each must be
    an active role of the workspace, otherwise 400 "Unknown buying role: {key}"), `crm_task` (bool,
    default true), and for `email` only `subject` (up to 200) and `body` (up to 10,000). Other
    channels drop them.
  - **Channels:** `email`, `linkedin`, `call`, `meeting` and `task`. They replace the nine older
    types (the mockup's set).
  - Days need not be unique. Steps are ordered by `order`.
- **Placeholders.** These may appear in an email's `subject` and `body` and in `detail`, and are
  rendered when the plan is built. Templates store the raw text.
  - `{account.name}`, `{offer.name}`, `{offer.promise}`, `{seller.first_name}`;
  - `{person.first_name}`: the first person linked to the step. With no one linked it renders
    "there" in an email and "the contact" elsewhere.
  - An unknown placeholder, or a known one with no value (for example `{offer.name}` on a plan with
    no lead offer), is left as written. Rendered values are not expanded again.

## Offer playbooks

`offer_playbook(offer_id, tier, template_id)` belongs to this module (Decision 25). The offers module
never imports playbooks, so the offers routes call it at the HTTP layer.

- `GET /api/v1/offers/{id}/playbooks` returns, for each of `act_now`, `good_fit` and `watch`:
  `{tier, playbook: {id, name, status, steps, days} | null, first_email: {subject, body} | null}`.
  `first_email` is the raw text of the template's first email step. It is the offer page's **initial
  message**, read-only with Copy (the offer form no longer has an initial message field).
- `PUT /api/v1/offers/{id}/playbooks/{tier}` with `{playbook_id | null}` sets or clears the mapping.
  It needs `offers:manage` or `playbooks:manage` (the Playbooks screen's Assign dialog is a
  playbooks action). An unknown tier is 400; an unknown, draft or archived template is 400 "That playbook
  isn't available."
- Changing a mapping affects accounts accepted from then on. Running plans keep their playbook.

## API

| Method and path | Scope | Does |
|---|---|---|
| `GET /api/v1/playbooks` | `playbooks:read` | Templates, optional `status`. Each has `steps` (count), `days` (largest step day), `channels` (count per channel), `runs_on` (`[{offer_id, tier}]`), `running` (active plans) |
| `GET /api/v1/playbooks/{id}` | `playbooks:read` | One template with `steps` (array), `steps_version`, optional `?version=` (404 outside 1 to current), plus the list's summary fields |
| `POST /api/v1/playbooks` | `playbooks:manage` | Create; optional `steps`; 201 |
| `PATCH /api/v1/playbooks/{id}` | `playbooks:manage` | Edit any field; a changed step set follows the versioning rule |
| `POST /api/v1/playbooks/{id}:duplicate` | `playbooks:manage` | Copy as a draft; 201 |
| `POST /api/v1/playbooks/{id}:archive` | `playbooks:manage` | Retire |
| `DELETE /api/v1/playbooks/{id}` | `playbooks:manage` | Delete; 204 or 409 |
| `GET /api/v1/offers/{id}/playbooks` | `offers:read` | The three tier choices (above) |
| `PUT /api/v1/offers/{id}/playbooks/{tier}` | `offers:manage` or `playbooks:manage` | Set or clear one tier |

## Seeds

Built in `playbooks/defaults.ts` and run by the dev seed after practices, offers and buying roles
exist (offers only exist there; production workspaces start with none, like offers). One active
template per seeded Taazaa practice. Existing workspaces get no back-fill.

- "Public sector RFP" belongs to AI Operating Platforms and has 4 steps, built from the Miami-Dade
  example: day 0 register as a county vendor and set alerts (task, seller); day 3 capability brief
  to the business owner (email, seller, `business_owner`); day 14 request an industry day through
  contracts (task, seller, `commercial_buyer`); day 21 conference presence and operator teaming
  (meeting, leader).
- Every other practice gets a 4-step "Standard outbound": day 0 intro email (plain language), day 3
  LinkedIn connect, day 7 follow-up email, day 14 call.
- Each seeded offer's `act_now` and `good_fit` map to its practice's template; `watch` stays empty.
  A rerun maps a tier only when it just created that template, so a mapping someone cleared stays
  cleared.

## Stories

### PLB-E1-S1 Create and edit templates (API R2c-1, screen R2c-2)
As a leader, I want to build playbooks, so that every account in that motion starts from what we know
works.
- PLB-E1-S1-AC1 A leader or owner can create a template with name, description, when to use, stop
  rule and ordered steps with every field above.
- PLB-E1-S1-AC2 Steps can be added, removed and reordered; days need not be unique.
- PLB-E1-S1-AC3 Saving an active template with step changes increments `version`; old versions remain
  readable.
- PLB-E1-S1-AC4 Archiving a template stops it being chosen; existing plans are untouched.
- PLB-E1-S1-AC5 A template that ran, or that an offer uses, cannot be deleted.

### PLB-E1-S2 Seed templates (R2c-1)
- PLB-E1-S2-AC1 The dev seed gives each Taazaa practice one template and maps its offers, as in
  Seeds above.

### PLB-E1-S3 Template performance (R3)
- PLB-E1-S3-AC1 The template page shows plans run, outcomes reached (reply, meeting, opportunity, won
  counts), median days to first meeting, and per channel the outcomes credited (from PLB-E6).
