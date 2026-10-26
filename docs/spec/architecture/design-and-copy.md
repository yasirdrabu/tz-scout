# Design and copy

Rules for every screen, email, CRM note and agent-facing text Scout produces. Carried from the v1
`CLAUDE.md` and the v1 Tailwind config.

## Look

- Clean, modern, light SaaS. Neutral warm palette: warm grays, white cards, one accent colour (plum).
  No navy or blue as the primary. No dark mode.
- Status colours only for meaning: green on target, amber near (within 15%), red off target, grey for
  "not enough data". Never use them for decoration.
- Dense but calm tables. Numbers right-aligned with tabular figures.
- Our own design, layout and wording throughout. Do not copy any competitor's screens, labels,
  scoring names or copy.

## Tokens (from v1 `tailwind.config.ts`)

| Token | Value | Use |
|---|---|---|
| `canvas` | `#F6F5F2` | page background |
| `surface` | `#FFFFFF` | cards |
| `sunken` | `#F1EFEB` | wells, inputs, table stripes |
| `line` / `line.strong` | `#E6E3DD` / `#D6D2CA` | borders |
| `ink` / `soft` / `muted` / `faint` | `#1F1C19` / `#45403A` / `#7A736B` / `#A39C93` | text |
| `accent` / `hover` / `soft` / `line` / `ink` | `#7B2D6B` / `#66235A` / `#F5ECF3` / `#E6CFE0` / `#5C1F50` | the one accent |
| `good` / `soft` / `line` | `#18794E` / `#EAF6EF` / `#BFE3CE` | on target |
| `near` / `soft` / `line` | `#A15C07` / `#FDF4E3` / `#F1D9A8` | within 15% |
| `bad` / `soft` / `line` | `#B42318` / `#FDEEEC` / `#F4C7C1` | off target |

Type: Geist Sans for text, Geist Mono for ids and code. Radius 6px (10px for large cards). Shadows
only `card` and `pop` from the v1 config.

## Copy

- Plain words. No jargon acronyms in the UI: write "cost per qualified lead", not "CPSQL"; "cost per
  click", not "CPC".
- No em dashes in UI copy, emails, CRM notes or agent tool descriptions.
- Buttons say what happens ("Approve and assign"), and the confirmation says what happened
  ("Assigned to Ash").
- Errors say what went wrong and how to fix it, without apologies.
- AI-written text that came from rules, not Claude, is labelled "Assembled from rules".
- Buyer-facing text (openers, emails, proposals) never quotes our internal research, intent data,
  lawsuits or breaches.

## Formatting values

Money from integer cents in the tenant's currency; rates shown as percents from decimals; dates in the
tenant's timezone. One shared formatting module (v1: `src/lib/format.ts`) does all of this; screens
never format numbers by hand.
