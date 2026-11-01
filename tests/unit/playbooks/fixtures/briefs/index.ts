import type { BriefInput } from '@/modules/playbooks/domain/brief-io';
import customer from './customer.json';
import intentOnly from './intent-only.json';
import noPeople from './no-people.json';
import notAFit from './not-a-fit.json';
import openDeal from './open-deal.json';
import transitRfp from './transit-rfp.json';

/** Recorded inputs for the `account_brief` checks (prompt-versions-and-checks.md), one per kind of account. */
export const BRIEF_FIXTURES: Record<string, BriefInput> = {
  'transit agency with RFP': transitRfp as BriefInput,
  'no people': noPeople as BriefInput,
  'intent only': intentOnly as BriefInput,
  'open deal': openDeal as BriefInput,
  customer: customer as BriefInput,
  'not a fit': notAFit as BriefInput,
};

/** The day the fixtures were recorded. */
export const FIXTURE_NOW = new Date('2026-10-31T12:00:00.000Z');

export const fixture = (name: keyof typeof BRIEF_FIXTURES): BriefInput => structuredClone(BRIEF_FIXTURES[name]!);
