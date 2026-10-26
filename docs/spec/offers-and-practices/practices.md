# OFF-E1 Practices

Release R1 · Was "buckets" (`src/lib/buckets.ts`)

## Why

A tenant sells through a few lines of business. Taazaa has four: AI Transformation, AI Operating
Platforms, Data & Engineering for AI Readiness, AI Marketing Studio. Imported research is filed by
practice, accounts are matched only to their practice's offers, and playbooks and briefs are set per
practice.

## Stories

### OFF-E1-S1 Manage practices
As an owner, I want to create, rename and archive practices, so that Scout mirrors how we sell.
- OFF-E1-S1-AC1 A practice has a name, description and keywords; slugs are unique per tenant.
- OFF-E1-S1-AC2 Archiving a practice with approved offers is blocked until those offers are moved or
  archived; the message names them.
- OFF-E1-S1-AC3 Seed data creates Taazaa's four practices and their offers as in `DEFAULT_BUCKETS`,
  including the two draft offers (AI Data Readiness Assessment, 30-Day GTM Audit and Pilot).

### OFF-E1-S2 File arrivals by practice
As an operator, I want imported sheets and agent arrivals filed into the right practice, so that they
match the right offers.
- OFF-E1-S2-AC1 `resolvePractice(hint)` (public interface) returns a practice id from a practice id,
  slug, name or keyword hint (a sheet's agent column, a file name, an agent's `practice` field), or
  null.
- OFF-E1-S2-AC2 An account with no practice is matched against every practice's approved offers
  (SCO-E1-S1-AC2), and the practice of its best offer becomes its suggested practice.

### OFF-E1-S3 Practice defaults
- OFF-E1-S3-AC1 Each practice can name a default playbook template and a brief template (used by
  Playbooks); both optional.
