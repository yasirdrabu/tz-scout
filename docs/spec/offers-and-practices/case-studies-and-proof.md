# OFF-E3 Case studies and proof

Release R1 · Carried from v1 Module 1

## Why

Proof decides deals. Briefs, playbook emails, proposals and the readiness score all need to know
which case studies back which offer, and which ones may be shown to a buyer.

## Stories

### OFF-E3-S1 Case studies as their own records
As an operator, I want case studies stored once and linked to many offers, so that proof stays
consistent.
- OFF-E3-S1-AC1 A case study has title, client, industry, result, link, and a "may be shown to buyers"
  flag (default off).
- OFF-E3-S1-AC2 A case study can link to any number of offers in the tenant; the offer page lists its
  case studies and the case study page lists its offers.
- OFF-E3-S1-AC3 Archiving a case study removes it from future briefs and emails but not from records
  already written.

### OFF-E3-S2 Find matching proof for an account
As an AE, I want the case study closest to my account suggested, so that my outreach has relevant
proof.
- OFF-E3-S2-AC1 `matchCaseStudies(offerId, industry, limit)` (public interface) returns linked case
  studies ordered by industry match (same match rule as fit), then most recent.
- OFF-E3-S2-AC2 Only case studies with the buyer-visible flag are returned for buyer-facing text
  (emails, proposals, the public report); briefs for internal use may show all.
