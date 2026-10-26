# ANL-E6 Who sees what, and exports

Release R3 · Module ANL

## Rules

| Who | Sees |
|---|---|
| Owner | Everything in the tenant, including the cost ledger and voided lines |
| Leader (CRO, sales leader) | All funnels, sources, costs and the scorecard |
| Seller (AE) | The funnel and outcomes of accounts assigned to them; no cost ledger; costs only as cost per won client for their own accounts |
| Operator | Funnels, sources, costs (no voiding) |
| Agent principal | Only its own source's performance (ANL-E3-S3), and costs only with `analytics:read` |

Data limits from `tenancy-and-access/roles-and-data-scopes.md` apply on top: a person limited to
certain practices sees only accounts in those practices.

## Stories

### ANL-E6-S1 Scoped analytics
As an AE, I want to see how my accounts are moving, without seeing everyone else's, so that I can
manage my book.
- ANL-E6-S1-AC1 A seller's funnel counts only accounts where `seller_user_id` is them.
- ANL-E6-S1-AC2 A seller requesting the cost ledger gets 403; the page hides it.
- ANL-E6-S1-AC3 An integration test proves each role sees only the rows above.

### ANL-E6-S2 CSV export
As a CRO, I want to export any analytics table to CSV, so that I can take it to a board slide.
- ANL-E6-S2-AC1 Every analytics table has "Export CSV"; the file has the same columns and filters as the
  screen, money in dollars with two decimals, rates as decimals.
- ANL-E6-S2-AC2 Exports respect the same scopes; every export is written to the audit log.
