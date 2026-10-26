# SCO-E4 Explain a score

Release R1

## Why

"A score nobody can explain" is an anti-goal. Every number Scout shows must break down into lines a
leader, an AE or an agent can read and check.

## The explanation

Stored as `account_score.explanation` (json) at scoring time, so it always matches the number shown.

```json
{
  "priority": 76,
  "tier": "act_now",
  "tierReason": "computed",
  "bestOffer": { "id": "off_…", "name": "Modernization Blueprint" },
  "lines": [
    { "group": "fit",    "label": "Industry",     "points": 30, "max": 30, "text": "Government transit matches Government." },
    { "group": "fit",    "label": "Company size", "points": 25, "max": 25, "text": "2,800 employees, in range." },
    { "group": "intent", "label": "Re-solicitation of the paratransit software contract", "points": 15.7, "max": 25,
      "text": "News from Sep 25, 2026 (30 days ago, counts 63%).", "signalIds": ["sig_…"], "kind": "trigger" },
    { "group": "combine", "label": "Match", "points": 65, "text": "55% fit (100) and 45% intent (22)." },
    { "group": "adjust", "label": "Warm intro from Zach Wiant", "points": 8 },
    { "group": "adjust", "label": "Source trust 0.72 (Yasir's research agent)", "points": 3 }
  ],
  "otherOffers": [ { "id": "off_…", "name": "FDE Sprint", "total": 58, "tier": "good_fit" } ],
  "missing": [ "Revenue unknown: adding it could change fit by up to 10 points." ],
  "computedAt": "2026-10-25T14:03:11Z",
  "profileVersion": 3
}
```

- `missing` lists unknown inputs that would change the score and by how much at most. It tells a
  leader which enrichment is worth paying for.
- Internal storage is camelCase; the API and MCP return snake_case.
- Each intent line carries the signal `kind` used by the API and MCP: `research`, `trigger` or
  `pain`. Finer signal types (leadership, funding, hiring and so on) stay in Accounts.

### Mapping to the `explain_score` tool and `GET /v1/accounts/{id}/score`

| Tool field | From |
|---|---|
| `offer` | `bestOffer.name`, or the requested `offer_id`'s name (built from that offer's `offer_match` row, with no warm or trust adjustments unless it is the best offer) |
| `priority`, `fit`, `intent`, `tier` | `account_score` (or the `offer_match` for a non-best offer: `priority` = match total) |
| `factors[]` | one entry per `lines[]` item in groups fit, intent and adjust: `name` = label, `points`, `max` (adjust lines: the cap), `reason` = text |
| `warm_intro_points` | the warm intro adjustment, 0 if none |
| `would_raise[]` | `missing` items as short phrases, plus up to 2 unmet signal rules with the most points ("A research signal in the last 30 days") and any target buying role with nobody on file ("A technical buyer on file") |
- Text follows UI copy rules: plain words, no acronyms, no em dashes.

## Stories

### SCO-E4-S1 Explanation on the account page
As a leader, I want to open any score and see each point's reason, so that I trust or correct it.
- SCO-E4-S1-AC1 Every line's points add up to the shown priority (fit lines × weight, intent lines ×
  weight, then adjustments), within rounding of 1 point; a unit test checks this for the worked
  examples.
- SCO-E4-S1-AC2 Each intent line links to its signals with date and source link.
- SCO-E4-S1-AC3 The `missing` list is shown under the breakdown when non-empty.

### SCO-E4-S2 `explain_score` tool and API
As an agent, I want to ask why an account scored as it did, so that I can tell the person I work for
or improve what I send.
- SCO-E4-S2-AC1 `explain_score` returns the explanation for an account the principal may read; for
  others it returns "not found" (never "forbidden", so existence is not leaked).
- SCO-E4-S2-AC2 The tool output matches the shape in `mcp/agent-tools.md` and adds a `summary`
  sentence, for example "Act now for Modernization Blueprint (priority 76): strong fit, a contract
  re-solicitation 30 days ago, and a warm intro from Zach Wiant."
- SCO-E4-S2-AC4 With `offer_id` for an offer that is not the best, the tool explains that offer's
  match and says which offer is best.
- SCO-E4-S2-AC3 `GET /v1/accounts/{id}/score` returns the same object.

### SCO-E4-S3 Why did it move
- SCO-E4-S3-AC1 The account page shows the last 10 `score_change` rows: from and to, cause in words,
  and when.
