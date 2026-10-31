# WEB screens

Every screen in the October 2026 mockups, in the order of the sidebar. Read [index.md](index.md)
first: shell, look, copy, calls C1 to C14 and the release tags apply to every screen here.

Each screen lists its **tag**, **route**, **who** (permission), **layout**, **data**, **actions**
(button copy exact, then the toast) and **states**. Sample values come from the mockups and are only
examples. "Mockup gap" marks something the mockup leaves open and the decision taken here.
"Decision {n}" means row {n} of "Decisions taken" in [api-gaps.md](api-gaps.md); the API gap pass's
decisions and spec corrections are applied below.

Shared patterns, used by many screens:

- **Filter popover.** One "Filter" button with a count badge. Left column categories (each with a
  count), right column options with counts, checkbox (pick any) or radio (pick one). Footer
  "{n} filters on" or "Nothing filtered yet" and `Clear all`. Active filters show as removable pills
  "{Category} {value}" with `Clear all`. Option counts come from the API.
- **Table.** 11 px uppercase tracked headers, numbers right-aligned, row hover wash, footer
  "Showing {n} of {total}" and the sort in words ("Sorted by priority, highest first"). Paged from the
  API with a cursor; "Show more" at the end, not page numbers.
- **Drawer.** Right side, 420 to 460 px, Esc closes, focus trapped, the URL carries what is open.
- **Confirm dialog.** Title as a question, the consequence in one sentence, the action button names
  the action ("Remove", "Retire offer"), `Cancel`.
- **States.** Every data screen has ready, empty, loading (skeleton rows with a line of what is
  loading) and error (what failed, what to do, `Try again`, error ref from the correlation id).
- **Names from the API.** Tier names, review status names and colors, stage names and order, reasons
  and permission labels always come from the API, never from constants in the app (C6, C7).
- **Handoff state.** After an assignment Scout sends the account to HubSpot in the background (up to
  6 tries). Wherever an assigned account shows, its handoff state shows as a chip: "Sending to
  HubSpot" (gray), "In HubSpot" (green), "HubSpot needs a decision" (amber), "HubSpot send failed"
  (red, with `Retry sending` for people with `crm:push`), "HubSpot send cancelled" (gray).

---

## 1. Sign-in

**Tag** R1 · **Route** `/signin?return=...` · **Who** anyone

Centered card on the page background: Scout mark, "Sign in to Scout", `Continue with Microsoft`.
Microsoft is the only sign-in method for now (Decision 19); `Continue with Google` comes later. The
methods shown come from the API's sign-in config. A development-only `Sign in as` list when the API
reports dev sign-in is on. Errors in plain words, one per code the API returns:
"Your account isn't a member of any workspace yet. Ask your owner for an invite." (`not_set_up`) /
"Your account is turned off. Ask your owner to turn it back on." (`account_turned_off`) / "Sign-in
didn't work. Try again, and if it keeps failing, ask your owner." (`sign_in_failed`). Later, with
allowed domains per workspace: "{domain} is not an allowed domain for this workspace." After sign-in
the app goes to the return path or the landing screen of the last used workspace.

## 2. Review queue

**Tag** R1 (flags for conflicts and enrichment requests are R2) · **Route**
`/t/:tenant/queue?tier=&practice=&offer=&source=&status=&peek=:accountId` · **Who** `review:act`
(owners, leaders and operators by default, W6)

**Layout.** Title "Review queue", subtitle "{n} accounts waiting for a decision. Oldest arrived
{age} ago." Button `Import a list` (to Import, with `imports:run`). Tier tabs with counts: `All`,
`Act now`, `Good fit`, `Watch`, and the lowest tier only when it has accounts. Tier names come from
the API: the lowest tier is "Not a fit" in today's scoring model (it also holds excluded accounts) and
"Nurture" once the scoring redesign lands (Decision 21). Filter (Practice, Best offer, Source, Review
status) and `Columns {n} of 12`. Table card with a bulk bar. Peek drawer over the right side.

**What it holds.** By default, accounts with no open assignment, plus accounts an AE declined
(flagged). An account leaves the queue as soon as it is assigned or sent back. Assigned accounts (with
their handoff state) and other statuses show only when the Review status filter asks for them.

**Columns.** Account is always shown. Default on: Best offer, Priority, Tier, Source, Review status,
Flags, Notes. Default off: Practice, Fit, Buying intent, Arrived. `Columns` popover "Customize
columns / Show, hide and reorder. Saved for you only." with `Reset`; the choice is stored per person
(API).

| Column | Shows | Example |
|---|---|---|
| Account | name; "{industry} · {location}" (+ " · Arrived {date}" when Arrived is hidden) | Miami-Dade County DTPW / Government · Miami, FL |
| Best offer | the offer someone picked when set (Decision 5), else Scout's best offer; practice underneath when Practice is hidden | Modernization Blueprint |
| Priority, Fit, Buying intent | bold number and a 4 px bar | 79, 85, 70 |
| Tier | chip: Act now (plum), Good fit (light plum), Watch (gray), lowest tier (white); "Was {old}" after a rescore, "Changed by {name}" when someone set it by hand (Decision 4) | Act now |
| Source | source name; "via" line underneath | RFP Watch / Marcus Lee · GovSpend |
| Review status | colored dot and name from Settings > Review statuses; "{status} by {name}" for a status a reviewer set (C13) | Ready for review |
| Flags | chips: "Declined by {AE}" amber (reason and date on hover and in the peek), "New from {source}" gray, "Warm intro" green, the handoff chip when the row is assigned; R2: "{n} conflict(s)" amber, "Enrichment requested" gray | Warm intro |
| Notes | comment icon and count | 1 |
| Arrived | date | Oct 24 |

Sorted by priority, highest first (the mockup has no sortable headers; none in this version).

**Actions.**
- Click a row: open the peek drawer (§3). Row checkbox selects; header checkbox selects all visible,
  up to 50 (the API's bulk limit). Above 50 it selects the first 50 and says "Selected the first 50.
  Bulk actions take 50 accounts at a time."
- Bulk bar "{n} selected": `Assign to an AE` (Assign dialog, §6, for all selected), `Send back`
  (Send-back dialog, §5, one reason and note for all; toast "Sent {n} accounts back to their
  sources."), `Clear selection`. Accounts the API refused in a bulk call stay selected and are listed
  with the API's message for each. Mockup gap: the mockup sends back with no reason; a reason is
  required (C5, Decision 1).
- Banner after scoring settings change: "{summary} · {when} by {name}" with "Priorities were
  recalculated with {weights as the API lists them}. {n} accounts changed tier." and `Open settings`
  (with `scoring:manage`). Shown when the API reports a recent rescore.

**States.**
- Empty: "The queue is clear" / "New accounts land here when a source sends them or someone imports
  a list. Each one arrives with a score, a best offer and a draft brief ready for your decision."
  `Import a list`, `Manage sources`. Footnote "Last account reviewed {when}." ("{n} sources are
  scheduled to send this week." joins it with scheduled pulls, R1d.) Filtered empty: "No accounts
  match these filters" with `Clear filters`.
- Loading: skeleton rows, "Loading accounts from {n} sources".
- Error: "The review queue didn't load" / "Scout couldn't reach its account store. Nothing was lost,
  and no decisions were changed. Try again in a moment. If it keeps failing, System health shows
  which queue is stuck." `Try again`, `Open System health` (platform admins only). "Error ref {ref} ·
  {time}".

## 3. Queue peek drawer

**Tag** R1 · **Route** search param `peek` on the queue · **Who** `review:act`

**Layout.** 460 px drawer. Header: up and down arrows (previous and next in the filtered list, also
`j` and `k`), "{i} of {n}", `Open full page`, close. Title, "{industry} · {location} · {domain}".
Buttons `Approve and assign` (Assign dialog), `Enrich` (R2; toast "Enrichment started for {name}. New
signals appear in about 2 minutes."), `Send back` (Send-back dialog).

**Body.**
- Scores: Priority, Fit, Buying intent.
- Details, inline selects that save on change. A changed field shows "Changed from {old}". Toast
  "{Label} changed to {value}."
  - Best offer: the approved offers, plus "Scout's pick ({offer})" to clear a choice (Decision 5).
  - Practice.
  - Tier: the tiers from the API, plus "Scout's tier ({tier})" to clear a manual tier. A tier set by
    hand shows "Scout scored this {old}. You changed it." and "Changed by {name}", and stays through
    rescores until someone picks Scout's tier again (Decision 4). The change carries a note field
    "Why change it?" (see api-gaps.md Open questions on whether it is required).
  - Review status: the statuses from Settings. Picking a send-back status opens the Send-back dialog
    (§5). Picking a declined status asks for a decline reason first (and a note when the reason
    needs one). Reopening a declined account asks for a note and puts it back in review.
  Read only: Source ("{source} · {via}"), Flags (chips or "None"; "Declined by {AE} on {date}:
  {reason}").
- Why now: the two newest dated signals; empty "No dated signals yet. Run Enrich to search
  procurement portals, news and job posts."
- Notes (Decision 3): "{n} notes", newest first, each "author · date · text"; textarea "Add a note
  for the team. Relationships, timing, why you changed something." (up to 4,000 characters)
  `Add note` (toast "Note added. Everyone reviewing this account can see it."; empty: "Write the note
  first, then add it.").
- Changes: newest first, "{Field} changed from {x} to {y}" by person and when, plus Scout's "Scored
  {n} and placed in {tier}" and "Arrived from {source}".

## 4. Account page

**Tag** R1 for the review view without conflicts, Enrich, playbook and committee gaps, built after
Playbooks (minimum) so it opens with Scout's recommendation and the brief filled (Decision 7); R2 for
the rest · **Route** `/t/:tenant/accounts/:id?from=queue|my|all` · **Who** `accounts:read`; actions
by permission

The page changes with stage: before review it leads with the decision; after assignment it leads with
the playbook, outcomes and CRM activity.

**Header (both stages).** Breadcrumb "{Review queue | My accounts | All accounts} / {name}"; in the
review view "{i} of {n}" with `Previous` and `Next` through the queue. Card: initials tile, name,
status pill (the review status from Settings with who set it, for example "Ready for review", "In
review by Dana", "Sent back to source"; after assignment the handoff state, for example "In HubSpot ·
{owner}"; "Waiting on enrichment" is R2), "{industry} · {location} · {domain}", pills Practice and
Best offer, origin line "From {source} ({via}) · Batch {id} · Arrived {date}" or "Assigned to {AE} by
{leader} on {date}". Buttons in review: `Enrich` (R2), `Send back`, `Approve and assign`. After:
`Reassign`, `Open in HubSpot` (opens the CRM record in a new tab), `Retry sending` when the HubSpot
send failed (with `crm:push`).

**Notices under the card.** "Declined by {AE} on {date}: {reason}. Assign someone else or send it
back." for an account an AE declined. "This account is linked to two HubSpot companies. Merge them in
HubSpot so Scout knows which one to update." when the API reports the conflict. "HubSpot needs a
decision" with the API's message when the send stopped on a decision.

**Stage tracker.** One step per pipeline stage, names and order from the API (C6), each with its
date, the current step marked, "Waiting on you" on the review step for a reviewer, "Next" on the next
step.

### 4a. Review view (before assignment)

1. **Scout's recommendation** (sparkle): one line and a paragraph from the API (Playbooks minimum).
   "Approve and assign to someone with public sector experience." / "The cancelled transit software
   RFP is being re-issued in December..."
2. **Before you approve** checklist, each a dot, text and link: unresolved conflicts (R2; "Resolve 1
   conflicting fact: annual technology budget." `Resolve` jumps to the fact; after: "Facts agree.
   Technology budget set to $18.4M."), committee gaps (R2; "Buying committee has no IT, security or
   technical buyer." `Find with Enrich`), warm intros ("Warm intro available through Ash Patel.").
3. **Score strip**, five tiles with bar and a note, as the scoring model returns them: Priority (note
   from the API's tier cutoffs, for example "Act now tier starts at 75"), Fit ("County transit agency
   with 3,000+ staff"), Buying intent ("RFP re-issue expected in December"), Revenue potential
   ("$250K to $400K in year one"), Source trust. In today's scoring model only Priority, Fit and
   Buying intent are scores "/ 100": Revenue potential shows "Arrives with enrichment" (R2) and
   Source trust shows "Not enough data yet" (every source starts the same until R3), and the
   Priority note is the API's sentence for the Act now thresholds. With the scoring redesign
   (Decision 21) all five are "/ 100"; Source trust stays the same for every source until R3, when
   its note becomes "RFP Watch: 6 won of 41 sent".
4. **Why now**: "{n} signals · newest first"; each date, text and source link.
5. **Account facts** with badge "{n} conflicts to resolve" or "All facts agree". Rows label and
   value. A conflict (R2) shows both values side by side with source and date and `Keep this one`;
   after: "Kept by {name} · Change", the other dimmed, toast "Kept {value} from {source}. Scout will
   use it in the brief and HubSpot."
6. **Brief** ("Last drafted {when}", from Playbooks minimum): Overview, Approach, Value angle, Risks,
   each tagged "Written by Claude", "Assembled from rules" or "Edited by {name}". `Edit` opens a
   textarea with `Save` and `Cancel`, hint "Saving marks this section as edited by you."; toast
   "{Title} saved".
7. **Playbook** preview (R2): "{name} · {n} steps over {d} days · starts when accepted", rows day,
   step, owner, status.
8. **Right rail.**
   - Buying committee: person (initials, name, title, role, note such as "Warm intro through Ash
     Patel"); gap rows ("No IT or security contact yet", "No technical buyer yet") with `Find` (R2);
     `Add a person` (form: name, title, email, role).
   - Notes ("Scout uses these in the brief"): the same note list as the peek drawer (§3), textarea
     "Add context Scout can't find. Relationships, past deals, timing." `Add note`.
   - Where it came from: Person > Agent > Data vendor chain, each source with its owner; tiles
     "Batch {id}" and "Source record {won} won of {sent} sent" (R3).
   - In HubSpot: the CRM check, either "Company exists. Open deal owned by Rita Gomez: Transit data
     audit, $48,000, last activity Aug 2." or "Company exists with no owner and no open deal. Scout
     can set the owner." or "Not in HubSpot yet."

### 4b. Assigned view (after assignment)

1. **Outcome tiles**: Meetings held ("Next: Nov 18 with Transit Operations", R2), Replies ("3 of 9",
   "Emails sent since Oct 27"), Buyers engaged ("2 of 4", gap in amber; R2), Opportunity ("Not yet" /
   deal name and value).
2. **Playbook** (R2): "{name} · Day {d} of {n}", progress bar "{d} of {n} done"; rows checkbox,
   day, step, owner, status ("Done", "Due Nov 18" amber row, "In progress", "Not started").
3. **HubSpot activity** ("Synced {when}"): dated entries of replies, emails, meetings, opens, and
   Scout's own actions ("Scout set Ash Patel as company owner, logged the brief and started the
   playbook.").
4. **Review record** ("Approved by {name} on {date}"): the scores, the brief sections shortened,
   `Show the full brief, signals and facts` (expands in place).
5. **Right rail**: Assignment (AE, "Accepted {when}", "Accepted automatically {when}" or "Waiting for
   {AE} to accept", the assigner's quoted note, the handoff state); Buying committee with engagement
   per person (R2: "Met Nov 4" green, "Opened, no reply" amber, "Not contacted" gray).

**States.**
- Building: dashed card "Scout is still building this brief" / "Scores, dated signals and the brief
  appear here as enrichment finishes. You can decide now with what the source sent, or run Enrich to
  search procurement portals, news, filings and job posts first." Section empties: Why now "No dated
  signals yet. Signals show here with their date and a link to where Scout found them."; Brief
  "Overview, approach, value angle and risks get drafted once Scout has at least two signals.";
  Buying committee "No people yet. Add someone you know, or Enrich will look for a business owner,
  commercial buyer and technical buyer."
- Loading: skeleton, "Loading the brief, signals and buying committee".
- Error: "This account didn't open" with the reason the API gives, `Try again`, `Open next account`,
  "{account id} · Error ref {ref}".
- Not found or outside the person's data limit: "This account isn't in your workspace, or you don't
  have access to it." with a link back.

## 5. Send-back dialog

**Tag** R1 · **Who** `review:act`

Opened from the account page, the peek drawer (the button, or picking a send-back status) and the
queue bulk bar. Title "Send back to {source} ({owner})", where the owner is the source's owner
(Decision 11), or "Send back to {source}" when it has none (bulk: "Send {n} accounts back to their
sources"). Reason chips from Settings > Review statuses > Send-back reasons, one required. Textarea
"What should the source fix before sending this again?": optional, and required when the picked
reason is marked "Note required" in Settings (Decision 1), with the helper "This reason needs a note.
Say what the source should fix." `Cancel`, `Send back to {owner first name}` (or `Send back`;
disabled until a reason is picked and any required note is written, helper "Pick a reason to
continue."). The account moves to the "Sent back to source" status; in bulk one reason and note go
with every account, up to 50. Toast "Sent back to {owner}. {name} left the queue." and the next
account opens (from the account page) or the row leaves (queue).

## 6. Assign dialog

**Tag** R1 (playbook choice R2) · **Who** `assign:act`

620 px modal. Title "Assign {account}" or "Assign {n} accounts" with the names underneath; sub
"{offer} · {practice}".
- **Account executive** radio cards: name, initials, practices, "{n} active accounts". An AE with no
  HubSpot user linked shows "No HubSpot user linked" and can't be picked (`Link in Members` for
  people with `members:manage`). "Best match" badge on one card, by a stated rule (Decision 8): the
  AE whose practice access covers the account's best offer, fewest active accounts first. The reason
  line comes from the API and says which, for example "Covers Digital Transformation and has the
  fewest active accounts (4)." No badge when nobody covers the offer.
- **CRM owner warning** (from the ownership preflight): "Scout can't take over the HubSpot owner" /
  "Rita Gomez owns an open deal on this company: Transit data audit, $48,000, last activity Aug 2.
  Scout will send the account and leave Rita as owner. Ask Rita to hand it over if {AE} should lead."
  In bulk, the warning lists each affected account.
- **Playbook** radio cards (R2): name, "{n} steps over {d} days", description, "Recommended for this
  account."
- **Note for {AE}**: "What should they know first?" (optional, up to 4,000 characters).
- Footer sentence: "Scout sends {account} to HubSpot with {AE} as owner and logs the brief." (R2 adds
  "and starts {playbook} on {date}") or, with the warning, "Scout sends {account} to HubSpot and
  leaves {owner} as owner."
- `Cancel`, `Assign to {AE full name}`. Toast "Assigned to {AE}. Sending {account} to HubSpot." or
  "Assigned {n} accounts to {AE}. Sending them to HubSpot." The send runs after the dialog closes; the
  row and the account page show the handoff state, and failures show there, not in this dialog.

**States.**
- Blocked (the preflight says the AE has no HubSpot owner): "{AE} has no HubSpot user linked, so
  Scout can't make them the owner. Link their HubSpot user in Settings > Members, or pick another
  AE."
- HubSpot unavailable (503 `crm_unavailable`): "HubSpot isn't answering, so Scout can't check who owns
  this company. Try again in a moment." `Try again`.
- A declined account is refused by the API ("Reopen it before assigning."); the dialog shows that
  message.

## 7. My accounts

**Tag** R1 (next step and due dates R2) · **Route** `/t/:tenant/my` · **Who** `assignments:respond`

Title "My accounts", subtitle "{n} new assignments to accept." (R2 adds "{n} next step due today,
{n} overdue.")
- **New assignments** (badge, hint "Accept to take it on. Declining returns the account to
  {assigner}."; R2: "Accept to start the playbook. ..."): rows with account link, "{offer}" (R2:
  " · {playbook} playbook"), "Assigned by {name} · {when}", the quoted note, `Decline`, `Accept`
  (toast "Accepted. {account} is in your accounts."; R2: "Accepted. {playbook} starts {day}."). The
  row shows the handoff state when the HubSpot send has not finished.
- **Accepted automatically.** An assignment the AE has not answered after {n} working days (Settings
  > Review statuses, default 2), or one they already acted on in HubSpot (a reply or a meeting), is
  accepted without them: it moves to Active with "Accepted automatically". The list can change while
  it is open; changes arrive through the "{n} updates" bar (C14).
- Opening an account from here marks it seen (`POST /api/v1/accounts/{id}:seen`), which clears its
  "New from {source}" flag.
- **Decline panel** "Why are you declining?": reason chips from Settings > Review statuses > Decline
  reasons for AEs (required), textarea "Anything {assigner} should know before reassigning"
  (required when the reason is marked "Note required"), helper "Pick a reason to continue.",
  `Cancel`, `Decline and return to {assigner}`. Toast "Declined. {account} is back with {assigner},
  with your reason."
- **Active** table: Account (name and offer), Stage chip, Next step (R2), Due (R2: "Due today" amber,
  "{n} days overdue" red, or a date), Last HubSpot activity (text and when). Row opens the account
  page.
- Empty: "No accounts assigned to you yet. When a leader assigns one, it shows here for you to accept."
  Loading and error as the shared pattern.

## 8. All accounts

**Tag** R1 · **Route** `/t/:tenant/accounts?stage=&q=&owner=&practice=&source=` · **Who**
`accounts:read` (rows limited by the person's data limit)

Title "All accounts", subtitle "{n} accounts across every stage. {won} won this year." `Export CSV`
(toast "Exported {n} accounts to scout-accounts.csv."). Stage tabs with counts, one per pipeline
stage from the API plus `All` and `Other` (sent back, not pursued, lost). Search "Find an account".
Filter: Owner (sellers and "Unassigned"), Practice, Source.

Columns: Account (name, "{industry} · {location}"), Stage chip, Owner (initials and name or
"Unassigned"), Best offer (and practice), Priority, Source, Next step (and due; R2), Last activity
(and when), Value (amount and "Open deal" or "Won"; "Estimated" R2). Footer "Sorted by stage, then
priority". Every row opens its account page. Filtered empty: "No accounts match these filters" / "Try
another stage or owner, or clear the filters to see every account in this workspace." `Clear filters`.

## 9. Overview

**Tag** R3 (stage counts can show from R1 data) · **Route** `/t/:tenant/overview` · **Who**
`analytics:read` (every role holds it; sellers see their data limit)

Title "Overview", sub "Where every account is this quarter, and who and what moved it there.
{quarter}, week {w} of {n}. Click any number to see what made it up." `Configure stages` (with
`settings:manage`, only once the stages editor exists, §21e).
- KPI tiles: Pipeline value ("{n} accounts at Opportunity"), Won value, Sent to Won ("Of accounts
  that entered this quarter"), Days to win ("Median").
- Pipeline funnel: one band per stage (names and order from the API) with "{x}% of {previous}",
  count, value at Opportunity and Won, "{count} of {target}" and pace ("Behind pace", "On pace",
  "Ahead") against "Where we should be today". "Left the pipeline": one band per exit, no target.
- Scorecard tabs `By seller`, `By offer`, `By practice`, sortable headers, every number clickable.
  By seller: Seller ("{n} accounts assigned"), Accepted, Time to accept, Steps on time, Meetings,
  Opportunities, Won ("Target {n}"), Pipeline, Win rate. By offer: Offer, Price, Matched,
  Opportunities, Won, Win rate, Won value, Pipeline. By practice: Practice ("Led by {lead}"), Offers,
  Matched, Opportunities, Won, Win rate, Won value, Pipeline. Green on or ahead of target, amber
  needs attention.
- Detail drawer on any number: eyebrow, title, value, change vs last quarter at this point, the
  definition ("Counts when: ..."), notes, breakdown bars by source, offer or seller (top 8), the
  accounts behind it (6, with `See all {n}` to All accounts filtered).
- Before R3: the stage counts and funnel from stage history; KPI tiles and scorecard show "Results
  arrive with analytics. Stage counts are live now." (C9).

## 10. Sources

**Tag** R1 (trust R3) · **Route** `/t/:tenant/sources` · **Who** `sources:manage` and `arrivals:read`

Title "Sources", sub "Every account traces back to a person, the agent they run and the data vendor
behind it. Trust decides how much Scout relies on what a source says." `Add a source`. Search "Find a
source", Filter Type (Person, Agent, Data vendor, List, Partner, CRM). The Trust filter (80 and up,
60 to 79, Below 60, Not enough data) comes with R3. `Expand all`, `Collapse all`.

Tree table: Source (caret, name, type, "New" or "Paused" tag, both from the API), How it sends (API
key, Through {parent}, File upload, Partner portal (R4), HubSpot sync), Trust ("Not enough data yet"
for every source until R3; then number and bar), Sent, Reviewed, Assigned, Won, Last sent. Archived
sources are not listed. The legend for the trust bands comes with R3. Empty "No sources match. Clear
the filters, or add a source."

## 11. Source page

**Tag** R1 (trust breakdown and cost per win R3) · **Route** `/t/:tenant/sources/:id/:tab?` · **Who**
`sources:manage` and `arrivals:read`

Breadcrumb Sources / parents / name. Header: initials tile, name, type, status pill (Active, Paused,
New), "Owned by {owner} · {method} · Part of {parent} · Last sent {when}" ("No owner" when none).
Buttons `Pause` / `Resume` (toasts "{name} paused. Anything it sends is refused until you resume it."
/ "{name} resumed. New accounts will reach review again."), `See in funnel` (R3), primary
`Import a list` (list sources) or `Sync now` (HubSpot).

Stat tiles: Sent, Reviewed (% of sent), Assigned (% of reviewed), Won (% of assigned), Trust ("Not
enough data yet" until R3), Cost per win (R3; "None yet", "Not tracked").

Tabs:
- **Overview**: "Where its accounts went" bars; Recent activity (what reviewers and AEs sent back or
  declined); Trust ("Updated nightly") from facts confirmed by reviewers, accepted by sales leaders,
  turned into wins (R3); Details (owner, how it sends, last sent, part of, runs or pulls from).
- **Accounts** ({n}): search, Filter Stage and Tier; columns Account, Stage, Tier, Priority, Best
  offer, Came in through (batch and child source), Owner, Arrived. Empty "No accounts yet" / "Accounts
  this source sends will show here with their stage and owner."
- **Batches** ({n}): the Batches table (§13) for this source.
- **Runs** (a person) or **Pulls from** (an agent): child sources with How it sends, Trust, Sent,
  Assigned, Won.
- **Settings**:
  - Owner select, on every source (Decision 11): "Answers for what this source sends." A person
    source starts owned by its person, an agent by its parent's person. Display only for now: nothing
    is routed to the owner yet. Toast "{owner} now owns {source}."
  - Connection, by method. API keys for this source (Decision 14, `sources:manage`, this source's keys
    only): name, masked key "scout_live_AbCd1234…" (the stored prefix; no last 4), created, last used;
    `Rotate key` (the new key shown once, "Copy this now. You won't see it again."; "The old key stops
    working within a minute."), `Revoke key` (confirm, toast "{name} revoked. Calls with it now
    fail."). `Import a list` (list sources), `Sync now` (HubSpot; toast "Sync started."; shows last
    synced and the last error; "Connect HubSpot first" when it isn't connected), `Copy portal link`
    (R4), `Open {parent}`.
  - Pause or remove: `Pause` / `Resume`. `Remove source` only when it has sent nothing (the API
    reports `has_sent` and refuses with 409 otherwise; confirm dialog "Remove {source}? It has sent
    nothing, so nothing else changes."). A source that has sent shows `Archive source` instead
    (confirm "Archive {source}? It stops sending for good and its keys stop working. Its accounts and
    history stay."), Decision 13.

Mockup gap: the mockup's Queue threshold setting is left out for now (Decision 10).

## 12. Add a source

**Tag** R1 · **Who** `sources:manage`

Three-step modal.
1. "Add a source / Pick what kind of source this is. You can change the details later." Cards: Agent
   ("An AI agent someone on your team runs, like RFP Watch."), Data vendor ("A company that sells
   account or contact data."), Partner ("A firm that refers accounts to you."), List or research
   sheet ("Files someone on your team uploads by hand."; kind `list`, sits under a person source,
   Decision 12), CRM ("Accounts that already live in HubSpot."; shown only when the workspace has no
   HubSpot source yet, since Scout polls one). `Continue`.
2. "Add a {type}": Name (errors "Give the source a name so its batches can be traced back to it." /
   "A source called {name} already exists. Pick another name."), Under (agents and lists need a
   person: "An agent needs an owner. Pick the person who runs it."), Owner (defaults to the person it
   sits under; Decision 11), Used by (data vendor, R1d: "The agent that pulls from this vendor."), How
   accounts arrive: Send through the API ("Scout creates a key for this source."), Upload files ("CSV,
   Excel or Markdown from the Import screen."), Sync from HubSpot ("Scout checks HubSpot for contacts
   that match your qualified-lead rule, marketing qualified leads by default, and sends each
   contact's company. The first check looks back 30 days."). Note on trust "Not enough data yet"
   until Scout learns from outcomes (R3). Placement hint ("Shows under {parent}"). `Back`,
   `Add source`. Toast "Added {name}."
3. "Source added": for API, the key shown once ("Copy this now. You won't see it again.") with a
   sample request against the real API host; for upload, `Upload the first list`; for HubSpot,
   `Run the first sync`; otherwise `Done`. The key is made under `sources:manage` for this source
   only (Decision 14).

## 13. Batches and imports

**Tag** R1 · **Route** `/t/:tenant/batches?status=&source=&sentBy=&runDate=&q=` · **Who**
`arrivals:read`; Import tab `imports:run`

Title "Batches and imports", sub "Every delivery from a source or a list you bring in. Scout matches
each account, scores it and sends it to review." Tabs `Batches ({n})`, `Import a list`.
- Attention banner when batches failed or need attention: "{n} batches need attention" with the
  issues and `Show them`.
- Search "Find by batch, file or notes"; Filter Status (Complete, In progress, Needs attention,
  Failed), Source, Sent by, Run date (Last 7, 14 or 30 days).
- Columns: Batch (id), Status chip, Sent by (source and person), Run date, Accounts, Notes and files
  (notes, file name, issue text and an action), Progress (stacked bar and "{n} resolved, {n}
  rejected, {n} waiting"). The API derives the status chip, the issue text and the progress line
  (it stores only processing and completed; Failed is a stopped import). Row actions `Retry {n} rows`
  (rows rejected for the daily limit, or left when an import stopped because its source was paused;
  shown only when the API reports retryable rows; toast "Retrying {n} rows in {id}. They're waiting
  again.") or `Download error report` (a CSV of the rejected rows).
- Empty: "No batches yet. Batches appear when a source sends accounts or someone imports a list."
  Filtered: "No batches match" / "Try another status or source, or clear the filters." `Clear filters`.

## 14. Batch detail

**Tag** R1 · **Route** `/t/:tenant/batches/:id?tab=` · **Who** `arrivals:read`; resolving waiting
rows `imports:run`

Breadcrumb Batches / {id}. Title is the batch notes; sub "{source} · {person} · Run {date} · {file}".
`Download file` (the original upload). Summary "{n} resolved", "{n} rejected", "{n} waiting on you",
and for people with `review:act` "{q} in the review queue". Tabs `All`, `Waiting`, `Resolved`,
`Rejected`. Columns Account, Website, Status, Priority. Status copy comes from the API's outcome:
"Resolved: New account", "Resolved: Matched {account}" (a known company keeps its review state),
"Rejected: Duplicate of another row in this batch", "Rejected: {reason}" (invalid row, excluded,
daily limit reached), "Waiting: Needs a website", "Waiting: Needs a company", "Waiting: Possible
duplicate".

Waiting rows, one form per reason:
- Needs a website: input "Add a website, like example.org" and `Resolve` (empty: "Add a website first,
  like {name}.org").
- Needs a company: company name and optional website, or "This is a sole proprietor" with the
  person's name; `Resolve`.
- Possible duplicate: the candidate accounts, each with `Same company`, and `It's a new company`.

Toast "{name} resolved." Footnote "Rows still waiting after 30 days are rejected."

## 15. Import a list

**Tag** R1 · **Route** `/t/:tenant/batches/import?step=` · **Who** `imports:run`

Stepper: Upload, Match columns, Confirm, Resolve.
1. **Upload**: dropzone "Drop a CSV, Excel or Markdown file here" / "Or click to choose one. Up to
   10,000 rows and 20 MB. One company per row." / "Each row needs a company name. A website helps
   Scout match the right company." Then Source and batch notes. People with `sources:manage` pick the
   source (their own, or a list, partner or person source; Decision 12); for everyone else the batch
   is credited to their own source, shown read only. Mockup gap: the mockup has no source or notes
   field; both are needed to credit the batch.
   - A workbook with more than one sheet adds a step: "Pick the sheet to import", one row per sheet.
   - Research and Vibe exports are recognised by their layout and skip Match columns and Confirm,
     going straight to Resolve.
2. **Match columns**: file card "{type} {file}, {n} rows · {sheet} · uploaded by {person}",
   `Use a different file` (discards this upload). "Match your columns / Scout suggested {n} of {m}.
   Check them, then confirm." Table: Your column, Sample values, Scout field (the API's list:
   Company name, Website, Location, Person name, Job title, Email, Phone, Notes, Don't import), tag
   "Suggested", "No match. Check this one" or "Changed by you".
3. **Confirm**: callout "{n} rows have no website / They'll be held in the batch until you add one.
   The other {m} rows go ahead now. You can add websites here or later from the batch." `Back`,
   `Import {m} rows and hold {n}`.
4. **Resolve** (live progress from the API): "Batch {id} created", "Matching companies and checking
   for duplicates", then "Done. {n} accounts resolved. {k} rows need you."; with `review:act`, "{q}
   are in the review queue."; "{notes} · {n} accounts"; progress "{n} resolved / {n} rejected / {n}
   waiting"; `Open the {k} waiting rows`, `Go to review queue` (with `review:act`).

Errors show the API's error title with what to change: unreadable file, no Company name or Website
column, over 10,000 rows ("This file has more than 10,000 rows. Split it and import the parts."),
over 20 MB, unsupported type.

## 16. Funnel by source

**Tag** R3 · **Route** `/t/:tenant/funnel?practice=&offer=&batch=&period=` · **Who** `analytics:read`

Title "Funnel by source", sub "How many accounts each source moved through each stage, and what each
one cost. Click a source for its stage-by-stage detail." Filter Practice, Offer, Batch, Period
(Last 30 days, Last 90 days, This quarter, This year; default Last 90 days). Tiles: Accounts sent
("{n} sources"), Won ("{x}% of sent"), Spend, Cost per won account ("Target {target}"). Table:
Source (and type), one column per stage (count, "{x}% from previous stage · {cost} per account"),
Spend, Cost per won account (green at or under target, amber within 50% over, red above, gray "Not
enough data" or "No wins yet"), win-rate bar. Legend line. Filters change the numbers (the mockup's
do not).

## 17. Funnel drill by source

**Tag** R3 · **Route** `/t/:tenant/funnel/:sourceId` · **Who** `analytics:read`

Breadcrumb Funnel by source / {name}; "{type} · {period}"; "{i} of {n}" with previous and next;
`Open source page`. Tiles Sent ("Accounts into review"), Won ("{x}% of sent · all sources {y}%"),
Spend ("{cost} per account sent"), Cost per won account ("Ranks {i} of {n} · target {target}").
Insight line from the API ("Too early to judge." under 10 sent; "Most accounts stall between {a}
and {b}."). Stage by stage table: Stage, Accounts (bar against the all-sources line), Moved on (% and
points vs all sources), Lost, Cost each. Batches list (click opens it). Won accounts (name, offer,
value; "No wins from this source yet.").

## 18. Costs

**Tag** R3 · **Route** `/t/:tenant/costs` · **Who** `analytics:read`; budgets `costs:write`

Title "Costs", sub "What finding accounts costs, where the money goes, and what each source returns
for it. Last 90 days." Tiles: Spend, Cost per account sent, Cost per won account (target), Return on
spend ("{n}x"). "Where the money goes" by category (Partner fees, Data vendors, Agents and hosting,
Lists and events, AI usage; the API maps its cost categories onto these), each with what is in it.
"Monthly spend" bars against the budget. "Monthly budgets", per category and month (Decision 26;
"Scout alerts the owner at 90% and pauses paid pulls at 110%."): per category used, "of {budget}",
"{n}% used", "Over by {x}", "{x} left"; `Edit budgets` to inputs, `Cancel`, `Save budgets` (toast
"Budgets saved. Monthly total {x}."). "Cost by source" table: Source, Spend, Share, Per account sent,
Per assigned, Per won account, Return; row opens the funnel drill. Footnote "Return is the value of
won deals divided by spend. Won value is what each deal closed at."

## 19. Offers and practices

**Tag** R1 (practices, offers, pricing, sections); seller guide and playbook by tier R2 · **Route**
`/t/:tenant/offers/:practiceId?/:offerId?` · **Who** `offers:read`; edits, making an offer active
or draft, retiring and deleting `offers:manage` (Decision 15)

Left tree: `New practice`; each practice with its offer count, offers with a status dot (Active,
Draft, Retired), `Add offer`.
- **Practice view**: name, "Led by {lead} · {n} offers", positioning; a card per offer (title,
  status, price, summary, "{n} accounts matched · {n} won" or "No accounts matched yet").
  `Delete practice`, `Edit practice`, `Add an offer to this practice`.
- **Offer view**: breadcrumb {practice} / Offer; title and status; "Updated {date} · Practice lead
  {name}"; `Duplicate`, `Retire` or `Delete` (Delete only for an offer that never matched an
  account), `Edit offer`. Price ("Fixed fee · 6 weeks"); stats Accounts matched, Won, Win rate;
  `See accounts for this offer` (All accounts filtered). Sections Summary, Ideal customer, Key offer,
  Why us, Why now (empty "Not written yet. Add it"). Playbook by tier (R2): Act now, Good fit, Watch
  selects with "{n} steps over {d} days · {x}% book a meeting", note "Changing a playbook affects
  accounts accepted from now on. Accounts already running keep the playbook they started with."
  Initial message with `Copy`. Seller guide (R2): Talking points, When they say (objection and
  answer), Proof points, Avoid.
- **Offer form** (fields per Decision 16): Title ("Give the offer a title."), Practice, Status
  (Active "Scout matches accounts to it", Draft "Hidden from matching"; Retired "Kept for history"
  is set by `Retire` and can't be undone), Pricing (Fixed fee, Starting at, Per month, Custom quote),
  Amount, Length (weeks), the sections (Summary is the offer's promise, Ideal customer its
  description, then Key offer, Why us, Why now), Who it's for (typical deal size, sales cycle in
  days, target titles or roles, industries, company size), Initial message, Talking points,
  Objections ("One per line, written as: objection | answer"), Proof points, Avoid. `Cancel`,
  `Save changes` or `Add offer`.
  - Making an offer Active needs a deal size, a sales cycle, a target title or role, and industries
    or a company size. When the API refuses, the form lists what is missing ("To make this offer
    active, add: ...") from its `errors[]`.
  - Changing who an Active offer is for moves it back to Draft; the form shows the API's warning
    ("This offer is back in Draft. Make it active again when you're ready.").
- **Practice form**: Name ("Give the practice a name."), Practice lead, Positioning. `Create
  practice` or `Save changes`.
- Confirms: "Retire {offer}?" (has matched accounts), "Delete {offer}?" (never matched), "Delete
  {practice}?" (blocked with "Retire or move its active offers first" while it has active offers;
  drafts and retired offers don't block it).
- Toasts "{title} added to {practice}.", "Changes to {x} saved.", "{x} is active.", "{x} is back in
  Draft.", "{x} retired.", "{x} deleted.", "{practice} created. Add its first offer."

## 20. Playbooks

**Tag** R2 · **Route** `/t/:tenant/playbooks/:id?` · **Who** `playbooks:read`; edits
`playbooks:manage`

The mockup's model wins (Decision 25): each offer picks a playbook per tier, steps are by day, a
playbook has a stop rule and a draft or send-automatically mode. `docs/spec/playbooks/` changes to
match before the R2 plan.

List: "Playbooks", sub "The steps an AE follows after accepting an account. Each offer picks a
playbook for each tier." `New playbook`. Four-step explainer (Offer and tier pick it; Starts on
acceptance; Scout prepares each step; Stops on a result). Table: Playbook (name, description),
Status, Steps ("{n} steps over {d} days", channel mix), Runs on (offers or "Not assigned"), Running,
Reply rate, Meeting rate (rates R3). Footnote on the 90-day window.

Detail: title and status, description, `Duplicate`, `Retire` or `Delete`, `Edit playbook`; tiles
Running now, Finished, Replied, Booked a meeting, Won (R3); Steps (Day {n}, channel badge, title,
detail, "{channel} · {who}", automation tag "Draft ready for AE", "Sends automatically", "HubSpot
task"); Runs on (offer, practice, tier chip, remove) with `Assign`; Rules (Starts when, Stops when,
Pauses when, Drafts).

Form: Name ("Give the playbook a name."), Status, When to use it, Stop when (They reply or book a
meeting, They book a meeting, Run every step), Scout drafts (AE reviews before anything sends, Send
emails automatically), Steps (Day, Channel, Done by, title, detail, reorder, remove; "Add at least
one step."), `Add step`, `Cancel`, `Save changes` or `Create playbook`.

Assign dialog: "Assign {playbook}" / "Accounts matched to this offer and tier will start this
playbook when an AE accepts them." Offer, tier checkboxes with "Already uses this playbook",
"Replaces {x}" or "No playbook now". Confirms for retire and delete.

## 21. Settings

**Route** `/t/:tenant/settings/:tab` · Tabs in order, each shown with its permission: Members
(`members:read`), Integrations (`integrations:manage`), API keys (`keys:manage`), Review statuses
(`settings:manage`), Pipeline stages (`settings:manage`, once the stages plan lands), Scoring weights
(`scoring:manage`, once the scoring redesign lands), Audit log (`audit:read`).

### 21a. Members

**Tag** R1 (editable roles and permissions and the Viewer role: Redesign, roles plan; Google sign-in
and allowed domains later) · **Who** `members:read`; changes `members:manage`

Inner tabs `Members ({n})`, `Roles and permissions`, `Login history`.
- **How people sign in** ("Members use their work account. Scout never stores a password."):
  Microsoft 365 only, with "{n} active members use this" (Decision 19). Google Workspace, per-workspace
  sign-in toggles and allowed domains come later and are not shown.
- Search "Search by name or email"; status tabs All, Active, Invited, Suspended. Columns Person (name,
  "You", email), Role (and practice access), Signs in with ("Microsoft", or "Not signed in yet"),
  Status (Active, Invited, Suspended), Last active (or "Not signed in yet"). `Invite people`.
- **Member drawer**: Role select (disabled for yourself and the last owner, with the reason; toast
  "{name} is now {role}. It applies the next time they load a page."); Practice access chips (for
  leaders and AEs: "They only see accounts, offers and pipeline for these practices."); HubSpot user
  ("Scout makes this person the HubSpot owner of accounts assigned to them."); Sign-in facts;
  `Sign out of every device` (confirm "Sign {name} out everywhere? This signs them out of every
  workspace on every device."); invited: `Copy sign-in link` (the plain Scout sign-in address; they
  get in the first time they sign in with Microsoft), `Revoke invite` (removes them); active: Recent
  sign-ins (from Login history), `Suspend` / `Reactivate` (toasts "{name} suspended. They can't use
  this workspace until you reactivate them." / "{name} reactivated."), `Remove from workspace`
  (confirm "Remove {name}? Their {n} open accounts go back to the review queue to be reassigned.
  Their sign-in history is kept.").
- **Invite dialog**: emails (commas or new lines), role cards, practice access, `Invite` or
  `Invite {n} people`; errors per address ("Already a member"). Scout sends no invite email in R1
  (Decision 18): after inviting, "Scout doesn't send invite emails yet. Send them this link to sign
  in: {sign-in address}" with `Copy link`. Invites don't expire. Invite emails, expiry and `Resend
  invite` come when Scout can send email.
- **Roles and permissions**: matrix of roles by permissions with the API's labels, grouped Accounts,
  Review and sources, Offers and playbooks, Pipeline and money, Workspace (the "Ask Scout" row is left
  out with the assistant). Read only until the roles plan lands (Decision 17); then editable per
  workspace, with the Viewer role as in the mockup. Owner column locked. Platform admin is not a
  column: "Taazaa platform admins can act in every workspace. They aren't a role here." (W8).
  `Restore defaults`, `Discard`, `Save permissions` (toast "Permissions saved. They apply the next
  time each member loads a page.").
- **Login history** (Decision 20): banner on failed sign-ins, `Show failed only`, Person select, tabs
  All, Signed in, Failed; columns When, Person, Method, Result (with reason), Where (IP address,
  "New IP" when that person hasn't signed in from it before), Device; `Export CSV`. "Last 30 days.
  Kept for 12 months."

### 21b. Integrations

**Tag** R1 (Apollo and Vibe R1d) · **Who** `integrations:manage`

Summary "{n} of {m} services working" with one sentence per issue. Groups and rows come from the API
(CRM, Data and enrichment, AI and so on). Microsoft sign-in is set up for all of Scout, not per
workspace, so it is not a row here; there is no Google Workspace row. Row: initial, name, what it is
used for, mode chip ("Live" or "Using sample data"), status dot and text, Last call, Calls today
("{n}"; "{n} of {cap}/day" with usage caps, R1d), `Manage` or `Connect`.

Manage panel (420 px): credential label (one per credential the service needs), masked value and
`Replace`, "Saved. Ends in {last4}."; paste input with errors ("Paste the {label} first. You can find
it in {name} settings." / "That is too short to be a {label}. Check you copied all of it."),
`Save and test`; `Test connection` with the result ("Connected. Round trip 182 ms. Read and write
scopes granted."); Mode switch with the confirm "Switch {name} to live?" (`Switch to live`, `Keep
sample data`; needs a saved credential and a passing test); tiles Calls today, Errors today, Response
average; Last 50 calls (All, Errors only): time, operation (for example `hubspot.test`), result,
status code, ms; "Connected by {name} on {date}", `Disconnect` (toast "Disconnected {name}. Scout
stopped calling it and switched to sample data.").

### 21c. API keys

**Tag** R1 · **Who** `keys:manage` (owners by default)

"Keys let agents and partners send accounts to Scout. Each key belongs to one source." `Create a
key`. People with `sources:manage` can also make and rotate a source's own keys from its page (§11,
§12, Decision 14). Columns Name ("Created {date} by {person}"), Source, Can do, Key (masked
"scout_live_AbCd1234…"), Last used, Errors ("{n} of last {total}"), `Access log`, `Revoke` (confirm,
then toast "{name} revoked. Calls with it now fail."). Mockup gap: the mockup revokes without a
confirm; a confirm is added.

Create dialog: Name ("Who or what will use this key"), Source, What it can do (Send accounts and
check status; Send accounts only; Read results only; the API turns each into permissions), `Create
key`; then the key shown once with `Copy` and "Copy this now. You won't see it again.", `Done`.

Access-log drawer (Decision 20): "{mask} · {scope}", `Export CSV`; "Last {n} calls · {span}"; tiles
Errors, From IPs (new IPs flagged), Response; status filter chips (All, Success, 401, 403, 409, 422,
429, 500); endpoint select; search "IP or request ID"; rows When, Request, Code, From IP, Time with
the error message; expand for request id, full time, client and payload size; `Show {n} more`.
"Scout keeps the last 1,000 calls for each key." Empty "No calls yet. They show here the first time
this key is used."

### 21d. Review statuses

**Tag** R1 ("Waiting on enrichment" R2) · **Who** `settings:manage` (people with `review:act` or
`assignments:respond` read the lists where they use them)

The full editor ships in R1 (Decision 2). The seeded statuses carry the mockup's words, for example
"Ready for review" and "Sent back to source".

"The steps an account goes through in the review queue, before it reaches a seller. Statuses set by
Scout change on their own. Statuses set by a reviewer change when someone acts." Table with
`Add status`: Color (Plum, Amber, Green, Red, Gray), Name, What it means, Set by (Scout,
automatically / A reviewer), Flag after (hours, "Never", "Final"), In it now ("{n}", "{n} late"
when they have been in it longer than Flag after), reorder, archive. The statuses Scout needs (the
first status, a reviewed one, a declined one, "Sent back to source") can be renamed and recolored
but not archived; archiving another status moves its accounts to the first status. Statuses are
archived, never deleted.

Send-back reasons ("A reviewer picks one when sending an account back. Sources see the reason, and
it feeds their trust score."): each reason with a "Note required" switch (Decision 1) and "{n} this
quarter", "Add a reason", at least one. Decline reasons for AEs (§7) are a second list in the same
form, each with "Note required". "Accept assignments automatically after {n} working days" (default
2; §7). `Restore defaults`, `Discard`, `Save statuses` (toast "Review statuses saved. The review queue
now shows them."). Mockup gap: the mockup has no decline-reasons editor and no auto-accept field.

### 21e. Pipeline stages

**Tag** Redesign (pipeline stages plan, Decision 6; quarter targets R3) · **Who** `settings:manage`

Stages become fully configurable in their own backend plan (routing, CRM and analytics). The editor
ships with that plan and the tab is hidden until then; meanwhile every screen reads stage names and
order from the API.

"The stages every account moves through, in order. They drive the pipeline, scorecard, filters and
HubSpot sync. Renaming keeps history; deleting moves accounts back one stage." Tables Stages and
Exits: Name, What it means, Moves here when (from the API's list of rules), HubSpot stage, Quarter
target (stages only), reorder, delete (the first and the won stage stay). `Add stage`.
`Restore defaults`, `Discard`, `Save stages` (toast "Pipeline stages saved. The pipeline and
scorecard use them now.").

### 21f. Scoring weights

**Tag** Redesign (scoring model plan, Decision 21) · **Who** `scoring:manage`

The screen follows the mockup's four-weight model, which needs the scoring redesign plan (a new
scoring model and a full rescore). The tab is hidden until that plan lands.

"Every account gets a priority score from 0 to 100. It blends four scores using these weights, and the
result puts the account in a tier. The tier picks which playbook runs." Sliders 0 to 60 in steps of
5 for Fit, Buying intent, Revenue potential, Source trust, each with what feeds it (Source trust:
"The same for every source until Scout learns from outcomes."; R3); total chip "Adds up to 100" or
the warning with `Balance to 100`. Tier cutoffs, one each for Act now, Good fit, Watch, with Nurture
below ("Each tier has to start higher than the one below it, and Act now at 100 or less."). "What
changes": tier counts before and after for the accounts scored in the last 90 days, and 8 sample
accounts with their parts, score, change and tier, all from an API preview (C8). `Restore defaults`,
`Discard`, `Save and rescore` (toast "Rescoring started."; no progress bar in R1). Footnote (Decision
22) "Saving rescores every account in this workspace, so accounts already with a seller can change
tier too. Tiers someone set by hand stay as they are, and running playbooks keep going."

### 21g. Audit log

**Tag** R1 · **Who** `audit:read`

"Every change to members, keys, integrations, settings, sources and tenants, and every sign-in.
Kept for 2 years. Nobody can edit or delete an entry." Sign-ins show here under the Sign-in area
and, with more detail, in Members > Login history. Search "Find an
action, person or target"; Filter Area (Tenants, Members, Sign-in, API keys, Settings, Integrations, Sources)
and Who. Columns When, Who, Area chip, What happened ("{action} · {target}" and detail), IP address.
`Export CSV`. Empty "No events match".

## 22. Admin: Tenants

**Tag** R1 for list, create, suspend and resume; Platform for everything else · **Route**
`/admin/tenants/:id?` · **Who** platform admin

Per-tenant infrastructure is decided (Decision 23): each tenant gets its own database, file storage
and encryption key, a region, backups and point-in-time restore, its own schema version and
migrations, provisioning and deletion states, seats, quotas, export, and support access the owner
grants. It is its own platform project, starting with an architecture change in
`docs/spec/architecture/`. Until it lands, this screen ships only what R1 can do, and every
Platform section below is hidden (not shown empty).

**R1.** "Each tenant is a separate company on Scout. Nothing is shared between tenants." `New tenant`.
Tile Tenants ("{n} active · {n} suspended"). Table: Tenant (initial, name, `scout.taazaa.ai/t/{slug}`),
Status (Active, Suspended), Members, Created.

Tenant drawer: General (owner, created, members, currency, timezone); `Suspend tenant` (confirm
"Suspend {name}? Nobody in it can sign in or use its API keys until you resume it."; toast "{name}
suspended.") / `Resume tenant` (toast "{name} resumed.").

New tenant panel: Company name, Slug ("Lowercase letters, numbers and dashes, up to 40 characters.
Starts and ends with a letter or number."; the workspace lives at `scout.taazaa.ai/t/{slug}`; error
"That slug is taken. Pick another."), Owner email ("They get the Owner role and sign in with
Microsoft."), Currency, Timezone. `Create tenant`. Creation is instant: the panel goes straight to
"{name} is ready", `Open tenant`, `Done`.

Platform admins are Taazaa staff with the platform-admin flag, all signing in with Microsoft (W8;
the mockup's separate super admins with passwords and security keys are left out). A "Platform
admins" list shows them with `Add platform admin` (an @taazaa.com email) and `Remove` (not yourself,
not the last one).

**Platform (hidden until the project lands).** Tiles Databases, File storage, Schema ("{x} of {n}",
"{n} behind v{v}"). Table columns "Test" tag, Region, Database, File storage, Members "{n} of
{seats}", Schema, Last backup; statuses Provisioning and Deleting. Drawer: General adds region and
seats; Database (engine, host, size, schema with `Run migration`, backups, point-in-time restore
window, `Back up now`, `Restore to a point in time`); File storage (bucket, used, quota, largest
upload); Encryption (`Rotate key`); Limits (API calls a minute, AI spend a month); Support access
(`Request access` / `End access`; "Only the tenant's owner can grant access, for 24 hours at a
time."); Danger zone adds `Export` and delete by typing the slug, "Scheduled for deletion" with
`Cancel deletion`. New tenant adds Region (can't change later), Database size, File storage, Seats,
Start with ("Scout defaults" or "Copy settings from {tenant}") and a live provisioning checklist.

## 23. Admin: AI runs

**Tag** R1 · **Route** `/admin/ai-runs` · **Who** platform admin

Every tenant's runs in one list (Decision 24). "Every call Scout makes to the model: briefs, scores,
fact checks and email drafts." Tiles Runs today, Failed (% and target under 3%), Median time
(slowest task), Spend today. Banner "{n} failed in the last hour" with `Show them`. Search "Find by
run, account or task"; Filter Status (Succeeded, Failed, Stopped by limit), Task, Tenant. Columns Run,
Status, Task and account, Tenant and model, Tokens, Cost, Time (red over 30 s), When. Runs show once
they finish. Expand: What Scout sent (the subject and a fingerprint of the input; Scout doesn't keep
the input itself), What came back, Error. No daily cap and no retry. Tenant owners keep their own
runs list through `GET /api/v1/ai-runs`.

## 24. Admin: System health

**Tag** R1 · **Route** `/admin/health` · **Who** platform admin

"All tenants · refreshed every 15 seconds". `Send test event` with "Round trip {ms} ms. Relay, queue
and worker all answered." Tiles Relay lag (target under 5 s), Pending work (across queues), Dead jobs
("Need a decision" / "None"), AI spend today. Pending work by queue (count, oldest, amber when old;
"Queue details are unavailable right now." when the API can't reach them). Dead jobs ("Failed {n}
times and stopped retrying"): id, queue, tenant, when, error, `Retry` (toast "{id} sent back to
{queue}"), `Discard` (confirm, toast "{id} discarded"); empty "No dead jobs. Jobs that fail {n} times
show here so you can retry or discard them." Schedules: name, cadence, next run, last result,
`Pause` / `Resume`, `Run now`.

## 25. Profile

**Tag** R1 · **Route** `/t/:tenant/profile` · **Who** any member

Name, email, role, practice access, sign-in method ("Microsoft" or "Developer sign-in"), active
sessions with `Sign out of every device`, `Sign out`. (Carried from the current Profile page; the
mockups only show the profile button.)

---

## Main flows (Playwright)

1. Leader reviews and assigns: queue, peek, open the account, resolve a conflict (R2), Approve and
   assign, pick an AE, the account shows Sending to HubSpot, then In HubSpot.
2. AE responds: My accounts, open the new assignment, accept; or decline with a reason and the
   account is back in the leader's queue.
3. Operator imports a list: Import, map columns, confirm, watch it resolve, open the waiting rows and
   add a website.
4. Owner checks results (R3): Funnel by source, drill into a source, open a batch and a won account.
5. First-time setup: sign in with Microsoft, connect HubSpot (paste token, test, switch to live),
   invite AEs and copy them the sign-in link, create an API key for an agent.
