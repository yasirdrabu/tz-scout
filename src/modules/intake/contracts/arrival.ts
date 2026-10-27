import { z } from 'zod';
import { normaliseDomain } from '../domain/normalise';

/**
 * `arrival.v1`: the one shape every way in produces (API, MCP, files, webhooks, enrichment).
 * `strict: true` is for the API and MCP (a company name and one identity, a date on every signal).
 * `strict: false` is for files, webhooks and vendors, whose rows can lack both.
 */

export const MAX_PEOPLE = 25;
export const MAX_SIGNALS = 50;
export const MAX_FACTS = 200;
export const MAX_BATCH_ITEMS = 1000;

const LINKEDIN = /linkedin\.com\//i;
const text = z.string().nullish();
const num = z.number().nullish();
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const date = z
  .string()
  .refine((s) => DATE.test(s) && !Number.isNaN(Date.parse(s)), 'Use a date like 2026-06-02.')
  .nullish();

const account = z
  .object({
    name: text,
    domain: text,
    website: text,
    linkedin_url: text,
    country: text,
    region: text,
    city: text,
    industry: text,
    employees: num,
    revenue_cents: num,
    notes: text,
    practice_hint: text,
    offer_hint: text,
    external_ref: text,
    description: text,
    employees_range: text,
    revenue_range: text,
    technologies: z.array(z.string()).nullish(),
    keywords: z.array(z.string()).nullish(),
    parent_domain: text,
    custom_fields: z.record(z.string(), z.unknown()).nullish(),
  })
  .strict();

const person = z
  .object({
    name: text,
    first_name: text,
    last_name: text,
    title: text,
    buying_role: text,
    buying_roles: z.array(z.string()).nullish(),
    email: text,
    phone: text,
    linkedin_url: text,
    notes: text,
  })
  .strict();

const signal = z
  .object({
    type: z.enum(['research', 'trigger', 'pain']).nullish(),
    fine_type: text,
    title: z.string().min(1),
    occurred_at: date,
    url: text,
    detail: text,
    confidence: z.number().min(0).max(1).nullish(),
  })
  .strict();

const factItem = z
  .object({ key: z.string().min(1), value: z.unknown(), observed_at: date, url: text, note: text })
  .strict();

const warmIntro = z
  .object({
    introducer_name: text,
    introducer_email: text,
    relationship: text,
    relationship_key: text,
    note: text,
  })
  .strict();

const research = z
  .object({
    hook: text,
    problem: text,
    pilot: text,
    price_cents: num,
    value_hypothesis: text,
    incumbent: text,
    caveats: text,
    contact_route: text,
    next_action: text,
    researcher_score: num,
    researcher_tier: text,
  })
  .strict();

export function ArrivalV1Schema(opts: { strict: boolean }) {
  // Only a research signal may be undated, and only when it comes from a file, webhook or vendor.
  const checkedSignal = signal.superRefine((s, ctx) => {
    if (!s.type && !s.fine_type) {
      ctx.addIssue({ code: 'custom', path: ['type'], message: 'Say what kind of signal this is.' });
    }
    const research = s.type === 'research' || (!s.type && s.fine_type === 'intent');
    if (s.occurred_at == null && (opts.strict || !research)) {
      ctx.addIssue({ code: 'custom', path: ['occurred_at'], message: 'Add the date it happened.' });
    }
  });

  const facts = z.union([
    z.record(z.string(), z.unknown()).refine((f) => Object.keys(f).length <= MAX_FACTS, 'At most 200 facts.'),
    z.array(factItem).max(MAX_FACTS, 'At most 200 facts.'),
  ]);

  return z
    .object({
      account: account.nullish(),
      people: z.array(person).max(MAX_PEOPLE, 'At most 25 people.').default([]),
      signals: z.array(checkedSignal).max(MAX_SIGNALS, 'At most 50 signals.').default([]),
      facts: facts.default({}),
      warm_intro: warmIntro.nullish(),
      research: research.nullish(),
      sole_proprietor: z.boolean().default(false),
      via_vendor: text,
      target_account_id: text,
    })
    .strict()
    .superRefine((a, ctx) => {
      if (!opts.strict) return;
      const d = a.account?.domain;
      if (d && normaliseDomain(d) === null) {
        ctx.addIssue({ code: 'custom', path: ['account', 'domain'], message: 'Must be a domain like acme.com.' });
      }
      const acc = a.account;
      if (acc?.website && normaliseDomain(acc.website) === null) {
        ctx.addIssue({ code: 'custom', path: ['account', 'website'], message: 'Must be a website like https://acme.com.' });
      }
      if (acc?.linkedin_url && !LINKEDIN.test(acc.linkedin_url)) {
        ctx.addIssue({ code: 'custom', path: ['account', 'linkedin_url'], message: 'Must be a LinkedIn page like linkedin.com/company/acme.' });
      }
      // A targeted arrival attaches to a known account, so it carries no company of its own.
      if (a.target_account_id) return;
      // A sole proprietor is the person: the shell account matches on their email.
      if (a.sole_proprietor) {
        if (!a.people.some((p) => p.email?.trim())) {
          ctx.addIssue({ code: 'custom', path: ['people'], message: "Add the person's email." });
        }
        return;
      }
      if (!a.account?.name?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['account', 'name'], message: 'Add the company name.' });
      }
      const hasIdentity =
        normaliseDomain(acc?.domain) !== null || normaliseDomain(acc?.website) !== null || LINKEDIN.test(acc?.linkedin_url ?? '');
      const gaveOne = [acc?.domain, acc?.website, acc?.linkedin_url].some((v) => v?.trim());
      // A value that was sent but is not valid already has its own message above.
      if (!hasIdentity && !gaveOne) {
        ctx.addIssue({ code: 'custom', path: ['account', 'domain'], message: 'Add a website, domain or LinkedIn page.' });
      }
    });
}

export type ArrivalV1 = z.infer<ReturnType<typeof ArrivalV1Schema>>;

/** Batch items carry `external_ref` and `notes` beside `account`. They belong in `account`. */
export function moveItemFields(item: unknown): unknown {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
  const { external_ref, notes, account: acc, ...rest } = item as Record<string, unknown>;
  if (external_ref === undefined && notes === undefined) return item;
  if (acc !== undefined && acc !== null && (typeof acc !== 'object' || Array.isArray(acc))) return item;
  const base = (acc ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    account: {
      ...base,
      ...(external_ref !== undefined ? { external_ref } : {}),
      ...(notes !== undefined ? { notes } : {}),
    },
  };
}

const envelope = {
  name: z.string({ error: 'Add a batch name.' }).trim().min(1, 'Add a batch name.'),
  run_at: z.iso.datetime({ offset: true, error: 'Use a date and time like 2026-10-24T18:00:00Z.' }).nullish(),
  notes: text,
  criteria: z.record(z.string(), z.unknown()).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
};
const itemCount = 'A batch needs 1 to 1,000 items.';

/** The batch fields with items left unchecked, so the caller can reject one item and keep the rest. */
export const BatchEnvelopeV1Schema = z
  .object({ ...envelope, items: z.array(z.unknown()).min(1, itemCount).max(MAX_BATCH_ITEMS, itemCount) })
  .strict();

/** The whole batch, every item validated as `arrival.v1`. */
export function BatchV1Schema(opts: { strict: boolean }) {
  const item = z.preprocess(moveItemFields, ArrivalV1Schema(opts));
  return z
    .object({ ...envelope, items: z.array(item).min(1, itemCount).max(MAX_BATCH_ITEMS, itemCount) })
    .strict();
}

export type BatchV1 = z.infer<ReturnType<typeof BatchV1Schema>>;
