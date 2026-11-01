# ACC-E4 Signals

Status: Draft · Release: R1

## Why

Signals are the "why now": dated events that say a company is in a buying window. Scoring (SCO) reads
them; the brief and the account page show them as a timeline with sources.

## Rules

- **Two levels.** The API and MCP speak in three **kinds** (`research`, `trigger`, `pain`). ACC keeps a
  finer **type** where the source gives one or Scout can tell, carried from today's `matching.ts`:

  | Type | Label | Kind |
  |---|---|---|
  | `intent` | Researching | research (Active research) |
  | `leadership` | Leadership change | trigger (Trigger event) |
  | `funding` | Funding | trigger |
  | `news` | Company event | trigger |
  | `risk` | Risk event | trigger |
  | `hiring` | Hiring | pain (Visible pain) |
  | `growth` | Headcount growth | pain |
  | `workforce` | Team makeup | pain |
  | `tech` | Tech stack | pain |

  - A signal sent with a fine type (`fine_type` in `arrival.v1`, or from files and vendors) stores it
    and derives the kind from the table.
  - A signal sent with only a kind (the MCP `SignalInput.type`) stores the kind with type empty. ACC
    then tries keyword rules on the title to set a fine type ("raised", "Series" → `funding`; "named",
    "appointed", "joins as" → `leadership`; "hiring", "job posting" → `hiring`) only when the result has
    the same kind; otherwise type stays empty.
  - API and MCP responses always show `kind`, and `type` when known.
  - New fine types are added in code with a kind, label and explainer (today's `SIGNAL_EXPLAINER`
    texts move here).
- Fields: `title`, `detail`, `url`, `value` (numeric where it means something: intent 0 to 100,
  growth as a decimal), `confidence` (0 to 1, from the source), `occurred_at` (required), source
  chain, arrival, `external_id`.
- **No duplicates**: same `(account, source, external_id)`, or same `(account, url, occurred_at
  date)`, or same `(account, kind, title normalised, occurred_at date)` is the same signal; it is not
  stored twice.
- Research signals with no date use the arrival date and show "this week" rather than the import time
  (today's honest labels). Only files and vendors can send undated research signals; the API requires
  `occurred_at`.
- Signal rules carried from today's Vibe converter (12 months, M&A only when a party, no crime
  stories as lawsuits, breaches described by what happened) apply at import (SRC-E4), not here.
- A person can archive a signal ("Not relevant") with a reason; archived signals don't score.

## Stories

### ACC-E4-S1 Record signals
As the intake pipeline, I want signals stored once with their date and source, so that scoring and the
timeline are right.
- ACC-E4-S1-AC1 The three duplicate rules hold (unit tests).
- ACC-E4-S1-AC2 Kind is always set; fine type is set from the source or the keyword rules, never to a
  type of a different kind (unit tests).
- ACC-E4-S1-AC3 Each stored signal publishes `accounts.signal.recorded` with type, kind, date, value
  and confidence.

### ACC-E4-S2 Why-now timeline
As a leader, I want the account's signals as a dated timeline with links, so that I can check the
reason to buy in seconds.
- ACC-E4-S2-AC1 The account page shows signals newest first with date, kind chip, title, source and
  link; the explainer for the type is one tap away.
- ACC-E4-S2-AC2 Archived signals are hidden behind "Show archived".

### ACC-E4-S3 Agents add signals
As an agent, I want to add a signal I found to an account, so that its timing is up to date.
- ACC-E4-S3-AC1 `add_signal(account_id, signal)` and `POST /api/v1/accounts/{id}/signals` submit an inline
  targeted arrival through SRC and return `signal_id` in the same call; a repeat returns the existing
  id.
- ACC-E4-S3-AC2 A missing `occurred_at` is rejected with "Add the date it happened"; a missing `url` is
  accepted but the signal shows "No source link" and the response says a link is strongly recommended.

## MCP tools

`add_signal`, as defined in [mcp/agent-tools.md](../mcp/agent-tools.md): input `account_id` and a
`SignalInput` (`type` as kind, `title`, `detail`, `occurred_at`, `url`, `confidence`); output
`signal_id` and `summary`.
