# AI-E2 Rules fallback

Release R0

## Why

Scout must work with no Anthropic key (carried from HANDOFF: "nothing breaks without it"), and it must
be honest about what was written by a model and what was assembled by rules.

## Rules

- A task may define `rules(input) → output` that builds a valid output from templates and data with
  no model call. Tasks without rules (e.g. call review) show "Add a Claude key to use this" instead of
  running.
- Mode resolution per run: tenant connection `mock` → mock output (labelled "Sample output"); live
  connection with key → live; no key, cap reached, or connection disabled → rules if available.
- Rules output is labelled "Assembled from rules" everywhere it appears, including in CRM notes.
- When a key is added later, an owner can regenerate rule-built text per account or in bulk.

## Stories

### AI-E2-S1 Work without a key
As an owner without a Claude key, I want briefs and sequences built from rules, so that the team can
work today.
- AI-E2-S1-AC1 With no key, an account brief is produced, stored with mode `rules`, and shown with the
  "Assembled from rules" label.

### AI-E2-S2 Regenerate with Claude
As an owner who just added a key, I want to rewrite rule-built text with Claude, so that quality
improves.
- AI-E2-S2-AC1 A bulk action "Rewrite with Claude" on the review queue enqueues runs for the selected
  accounts and shows progress; human-edited sections are skipped unless the person ticks "Include
  edited sections".
