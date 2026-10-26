# Taazaa Scout: UX design brief

## The product in one paragraph

Taazaa Scout finds companies with a real reason to buy now, matches each to the offer it is most likely to buy, and puts it in front of a person who decides. Accounts arrive from many places: data vendors, research sheets, CSV lists, HubSpot, partners, and AI agents that people run. A sales leader reviews each account, adds what they know, and assigns it to an account executive (AE). Scout then pushes it to the CRM (HubSpot for now), runs an account-based playbook against it, and shows what each source, play and dollar produced. **People decide; Scout scores, drafts and tracks.**

## Who uses it, and what they come to do

| Person | Comes in to | Most-used screens |
|---|---|---|
| **Sales leader** (the reviewer) | Clear the review queue: read the brief, keep or decline, assign to an AE | Review queue, Account page |
| **AE / seller** | See their assigned accounts, accept or decline, follow the plan | My accounts, Account page (mostly works in HubSpot) |
| **Owner / CRO** | See what's working: funnel and cost by source, trends | Analytics, Settings |
| **Operator** | Bring accounts in, manage sources, offers and playbook templates | Sources, Imports, Offers, Playbooks |
| **Platform admin** (Taazaa) | Create tenants, watch system health | Admin |

Each company using Scout is a separate tenant (Taazaa first, clients later). A person can belong to several, so the header needs a workspace switcher.

## Navigation

Left sidebar, grouped. Top of sidebar: workspace switcher. Bottom: profile, Settings.

- **Work:** Review queue (with count badge), My accounts, All accounts
- **Sources:** Sources, Batches, Import
- **Plan:** Offers and practices, Playbooks
- **Results:** Funnel by source, Costs, Scorecard
- **Settings:** Members, Integrations, API keys, Review statuses, Scoring weights, Audit log
- **Admin** (platform admins only): Tenants, System health, AI runs

Hide what a person can't use; don't show disabled items.

## Key screens

1. **Review queue.** The leader's home. A dense table: account, best offer, practice, priority score, tier (Act now, Good fit, Watch), source, review status, flags (conflicting facts, enrichment requested, warm intro). Filters by practice, offer, source, tier, status. Bulk select to assign. Clicking a row opens the account page.

2. **Account page (most important screen).** One long page you read top to bottom, then act on. Header: name, practice, offer, review status, where it came from, and the main actions: **Enrich**, **Send back**, **Approve and assign**. Then:
   - Score strip: priority, fit, buying intent, revenue potential, source trust.
   - Why now: dated signals, each with its source link.
   - Account facts: where two sources disagree, both values show side by side with a "Keep this one" choice.
   - Buying committee: people with roles (commercial buyer, technical buyer, business owner, influencer…), with gaps called out ("No IT or security contact yet").
   - Brief sections: overview, approach, value angle, risks. Each is editable and labelled "Written by Claude" or "Assembled from rules".
   - Playbook: a checklist of steps with week, owner and status.

   **The page changes with stage.** Before review it leads with the decision; after assignment it leads with the playbook, outcomes and CRM activity. A stage tracker runs across the top: Arrived, Reviewed, Assigned, Engaged, Opportunity, Won.

3. **Assign dialog.** Pick an AE, add a note, choose a playbook. Warn when Scout can't take over the CRM owner (open deal or existing customer).

4. **My accounts (AE).** The AE's assigned accounts with accept or decline (decline asks for a reason), next step due, and last CRM activity.

5. **Sources.** A tree: person, then their agent, then the data vendor. Each source shows trust score, accounts sent, and how many were reviewed, assigned and won.

6. **Batches.** One row per batch: who sent it, run date, count, notes, files, and a progress bar of resolved, rejected and waiting. Detail page lists every account in the batch with its status.

7. **Import.** Drag in CSV, Excel or Markdown. Scout suggests a column mapping; you confirm it. Rows with no website are held with an inline field to add one.

8. **Funnel by source.** Funnel stages as columns, sources as rows, with conversion and cost per stage. Filter by practice, offer, batch and period.

9. **Integrations.** One row per service (HubSpot, Apollo, Claude, …): "Using sample data" or "Live", status, last call, calls today. Manage panel: masked credential ("Saved. Ends in 4f2a."), Test button, mode switch, and the last 50 calls.

10. **API keys.** List and create. Creating a key: name, source, scope presets ("Send accounts and check status"), shown once with "Copy this now. You won't see it again."

11. **System health (admin).** Relay lag, pending work per queue, dead jobs with Retry and Discard, schedules with Pause and Run now, and a "Send test event" button showing round-trip time.

## Main flows to design

1. **Leader reviews and assigns:** Review queue, open account, read brief, resolve one conflict, Approve and assign, pick AE and playbook, account moves to "In HubSpot".
2. **AE responds:** sees a new assignment, opens it, accepts (or declines with a reason, which returns it to the leader).
3. **Operator imports a list:** Import, map columns, confirm, watch the batch resolve, open the waiting rows.
4. **Owner checks results:** Funnel by source, drill into one source, see its batches and won accounts.
5. **First-time setup:** owner signs in with Microsoft, connects HubSpot (paste token, test, switch to live), invites AEs, creates an API key for an agent.

## Visual direction

- Clean, modern, light SaaS. Warm neutral grays, white cards, **one accent: plum** `#7B2D6B`. No navy or blue as the main color. No dark mode.
- Status colors only for meaning: green on target `#18794E`, amber near `#A15C07`, red off target `#B42318`, gray for "not enough data".
- Dense but calm tables. Numbers right-aligned with tabular figures. Type: Geist Sans, Geist Mono for ids.
- Page background `#F6F5F2`, cards `#FFFFFF`, borders `#E6E3DD`, text `#1F1C19` / muted `#7A736B`.
- Our own design and wording. Do not imitate any competitor's screens, labels or scoring names.

## Copy rules

- Plain words, no acronyms in the UI: "cost per qualified lead", not "CPQL".
- No em dashes anywhere.
- Buttons say what happens ("Approve and assign"); confirmations say what happened ("Assigned to Ash").
- Errors say what went wrong and how to fix it, without apology.
- Empty states say what will appear and how to get the first one in.

## What I need from you

1. Sidebar and header (with workspace switcher).
2. High-fidelity: Review queue, Account page (before review and after assignment), Assign dialog.
3. Mid-fidelity: My accounts, Sources, Batches (list and detail), Import mapping, Funnel by source, Integrations, API keys, System health.
4. Empty, loading and error states for the Review queue and Account page.
5. Desktop first (1440 wide); the review queue and account page should also work on a laptop at 1280.

**Out of scope:** billing, sign-up, marketing site, mobile apps, dark mode.

Use realistic sample data: Taazaa's practices (AI Transformation, AI Operating Platforms, Data and Engineering for AI Readiness, AI Marketing Studio), offers such as "Modernization Blueprint" and "AI Opportunity Map", and an account like **Miami-Dade County DTPW**: a public agency, priority 79, fit 85, intent 70, a cancelled software RFP being re-issued in late 2026, and buyers Jarice Rodriguez (business owner) and Alonzo Joseph (commercial buyer).
