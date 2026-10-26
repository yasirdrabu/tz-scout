# OFF-E2 Offers and AI drafts

Release R1 (manual offers, approval), R2 (AI drafts) · Carried from v1 Module 1

## Why

Every match, brief and playbook starts from an offer: what it promises, who buys it, what it costs,
and what proof stands behind it. Nothing should be matched against an offer an owner hasn't approved.

## Rules

- States: `draft` → `approved` → `archived`. Only approved offers are matched, shown to agents, or
  used by playbooks.
- Editing the **buyer definition** of an approved offer (industries, size, revenue, regions, titles,
  buying roles, exclusions) sends it back to draft (carried from v1). Editing other fields (promise,
  price, proof points) keeps it approved and publishes `offers.offer.changed`.
- `target_buying_roles` lists which buying-committee roles the offer needs (for example business
  owner, commercial buyer, technical buyer). Playbooks uses it to show committee gaps; Scoring counts a
  person in one of these roles as "buyer on file".
- Money in cents; margin, expansion rate as decimals.

## Stories

### OFF-E2-S1 Create, edit, archive an offer
As an operator, I want to record an offer with its buyer and economics, so that Scout can match
accounts to it.
- OFF-E2-S1-AC1 Every field in the `offer` table can be set in the form; required to save: name,
  practice, promise.
- OFF-E2-S1-AC2 Required to approve: promise, at least one target title or buying role, at least one
  of industries or size range, typical deal size, sales cycle days.
- OFF-E2-S1-AC3 Archiving publishes `offers.offer.archived`; the offer disappears from matching and
  from `list_offers`, but historic matches, plans and wins keep pointing to it.

### OFF-E2-S2 Approve an offer
As an owner, I want to approve offers before they're used, so that reps don't sell something we
haven't agreed.
- OFF-E2-S2-AC1 Approving needs `offers:manage` and the owner role; the button is hidden for others
  and the API returns 403.
- OFF-E2-S2-AC2 Approval publishes `offers.offer.approved` and Scoring rescores the practice.
- OFF-E2-S2-AC3 Changing the buyer definition of an approved offer shows "This sends the offer back to
  draft until an owner approves it" before saving.

### OFF-E2-S3 Draft an offer with AI (R2)
As an operator, I want to paste a URL or upload a deck or case study and get a drafted offer, so that
setup takes minutes.
- OFF-E2-S3-AC1 Accepts a URL, PDF, Word or PowerPoint file (up to 20 MB); text is extracted and sent
  to the `offer_draft` AI task.
- OFF-E2-S3-AC2 The draft fills at least promise, target titles or buying roles, industries and proof
  points; each AI-filled field is marked "Drafted by Claude" until a person edits it.
- OFF-E2-S3-AC3 The result is always a draft; it is never used elsewhere until approved.
- OFF-E2-S3-AC4 Without an AI key the action is hidden and the form says drafting needs Claude to be
  connected in Integrations.
