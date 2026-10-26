# PLB-E3 Account brief

Release R1 (core sections, rules fallback), R2 (practice templates, custom fields)

## Why

The brief is what a leader reads to decide and what an AE reads before the first touch. The user's
Miami-Dade DTPW one-pager is the model: overview, what they service, potential size, why now with
dated signals, decision makers and entry points, possible ABM approach, touch points, value angle,
risks.

## Rules

- **Sections** (default template, used when a practice defines none):

| Key | Label | Content |
|---|---|---|
| `overview` | Overview | 3 to 5 sentences: who they are, the situation, the opening |
| `what_they_do` | What they do | Their services or operations relevant to the offer |
| `potential_size` | Potential size | Known scale facts (users, volume, contract values) with sources |
| `why_now` | Why now | Numbered dated signals, each with source and why it matters (built from scored signals) |
| `decision_makers` | Decision makers and entry points | People with role, buying role and the entry point (from Accounts) |
| `approach` | Possible approach | The motion and the first moves |
| `value_angle` | Our value angle | What the offer does for them, with the matching case study |
| `risks` | Risks and watch-outs | Timing, incumbents, likely competitors, process constraints |

- Touch points are not a brief section: they are the account plan (PLB-E2), shown in the brief.
- A practice can define its own brief template (add, rename, reorder sections, write Claude's
  instructions per section) and **custom fields** (for example "Fleet tier", "ABM motion",
  "Revenue potential" override, "Contract end date"). Fields marked `show_in_strip` appear in the
  score strip.
- **Drafting:** in R1 the `account_brief` AI task (carried from v1) writes why now, the angle, the
  opener and who to contact first; the other core sections come from rules. From R2 the
  `brief_sections` task drafts every section of the practice's template from the account's facts,
  signals, people, best offer, case studies and score explanation, and `committee_gaps` names missing
  buying roles with titles to look for. Every AI-written claim cites the fact and signal ids it used
  (`citations`); a section with an uncited number is rejected by validation and redrafted once. Without Claude, sections are assembled from
  rules and labelled "Assembled from rules" (carried from v1). Briefs never quote research intent,
  lawsuits or breaches in buyer-facing text (carried rule).
- **Editing:** any section can be edited by a person with `playbooks:write`. Each section shows who last
  changed it and whether it was drafted by Claude, assembled from rules, or written by a person.
  Redrafting a section a person edited asks first (built into the page) and keeps the old version.
- Facts in `potential_size` and `why_now` link to their facts and signals (provenance from Accounts).
- When the best offer changes, `why_now`, `approach` and `value_angle` show "Written for <old offer>"
  with a "Redraft" action.

## Stories

### PLB-E3-S1 Draft a brief
As a leader, I want a brief drafted when an account becomes worth looking at, so that review starts
from a one-pager, not raw data.
- PLB-E3-S1-AC1 Given an account first scored act now or good fit, a brief exists within 60 seconds
  (AI) or 5 seconds (rules), with every required section of its template.
- PLB-E3-S1-AC2 Each AI-drafted section records its AI run id; the prompt version is visible to admins.
- PLB-E3-S1-AC3 A leader can trigger "Draft brief" on any account by hand.

### PLB-E3-S2 Edit a brief
- PLB-E3-S2-AC1 Editing a section saves a new version with editor and time; "History" shows earlier
  versions.
- PLB-E3-S2-AC2 An agent with `playbooks:write` can update sections; the section shows the agent's name.

### PLB-E3-S4 Handoff package for the CRM (R1)
As the CRM sync module, I want one call that returns everything the CRM note and tasks need, so that
CRM never has to import Playbooks, Scoring or Offers.
- PLB-E3-S4-AC1 PLB implements CRM's `HandoffPackageProvider.package(ctx, accountId, assignmentId)`
  and is registered in the worker and web composition roots.
- PLB-E3-S4-AC2 The package contains: priority, fit, intent and tier with fit parts and reasons (from
  SCO), best offer with price, sales cycle, usual buyers, proof points and matching case studies (from
  OFF), the brief sections with citations, the opener and who to approach first, the follow-up
  sequence (day 0, 3, 7, 14), and the plan steps that have `crm_task` true (empty in R1 before plans
  exist).
- PLB-E3-S4-AC3 With no Claude key, the package is built from rules and every AI-shaped part is marked
  "Assembled from rules".
- PLB-E3-S4-AC4 The package never quotes research intent, lawsuits or breaches in buyer-facing text
  (opener, follow-ups); they may appear in internal note sections.

### PLB-E3-S3 Practice brief templates and custom fields (R2)
As an owner, I want each practice to have its own brief sections and fields, so that a public-sector
transit account and an AI marketing account each get the brief that fits.
- PLB-E3-S3-AC1 Settings → Practices → Brief lets an owner add, remove, reorder sections and write
  instructions for Claude per section.
- PLB-E3-S3-AC2 Custom fields of type text, number, money (cents), select and date can be defined;
  values can come in arrivals (mapped by key) or be typed by people.
- PLB-E3-S3-AC3 Changing a template does not rewrite existing briefs; missing sections show "Not
  drafted yet" with a "Draft" action.
