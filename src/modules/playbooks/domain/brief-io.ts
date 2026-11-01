// The `account_brief` task's input and output (Ruling 1, Global Constraints limits).
import { z } from 'zod';
import { SECTION_MAX } from '../contracts/types';

export const CITE_MESSAGE = 'Cite the fact or signal ids for every number.';
export const HEADLINE_MAX = 120;
export const DETAIL_MAX = 600;
export const SUBJECT_MAX = 90;
export const OPENER_MAX = 700;
export const DESCRIPTION_MAX = 1000;
export const SIGNAL_TITLE_MAX = 200;
export const FACT_VALUE_MAX = 500;
export const NOTE_MAX = 1000;
export const INSIGHTS_MAX = 2000;
export const NO_LINKS_MESSAGE = 'Leave links and email addresses out of the opener.';

/** A URL (with a scheme or www) or an email address: never in the opener a seller sends as their own. */
export const hasLinkOrEmail = (s: string) => /\bhttps?:\/\/|\bwww\.|[\w.+-]+@[\w-]+(\.[\w-]+)+/i.test(s);

/** Task input caps (Global Constraints). */
export const INPUT_CAPS = { signals: 20, facts: 40, people: 15, notes: 10, caseStudies: 3 } as const;

const tier = z.enum(['not_fit', 'watch', 'good_fit', 'act_now']);

export const briefInputSchema = z.object({
  account: z.object({
    name: z.string(),
    industry: z.string().nullable(),
    employees: z.number().nullable(),
    location: z.string().nullable(),
    description: z.string().max(DESCRIPTION_MAX).nullable(),
    technologies: z.array(z.string()),
  }),
  offer: z
    .object({
      id: z.string(),
      name: z.string(),
      promise: z.string(),
      priceMinCents: z.number().nullable(),
      priceMaxCents: z.number().nullable(),
      salesCycleDays: z.number().nullable(),
      targetTitles: z.array(z.string()),
      targetBuyingRoles: z.array(z.string()),
      proofPoints: z.array(z.string()),
    })
    .nullable(),
  practiceName: z.string().nullable(),
  caseStudies: z.array(z.object({ id: z.string(), title: z.string(), clientName: z.string().nullable(), result: z.string().nullable() })).max(INPUT_CAPS.caseStudies),
  /** Dated ones newest first. */
  signals: z
    .array(
      z.object({
        id: z.string(),
        type: z.string().nullable(),
        kind: z.enum(['research', 'trigger', 'pain']),
        title: z.string().max(SIGNAL_TITLE_MAX),
        occurredAt: z.string().nullable(),
        sourceName: z.string().nullable(),
      }),
    )
    .max(INPUT_CAPS.signals),
  facts: z.array(z.object({ id: z.string(), key: z.string(), value: z.string().max(FACT_VALUE_MAX) })).max(INPUT_CAPS.facts),
  /** No contact details. */
  people: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        title: z.string().nullable(),
        roleKeys: z.array(z.string()),
        roleLabels: z.array(z.string()),
        isPrimary: z.boolean(),
      }),
    )
    .max(INPUT_CAPS.people),
  score: z.object({
    tier,
    tierLabel: z.string(),
    priority: z.number(),
    fit: z.number(),
    intent: z.number(),
    fitParts: z.array(z.object({ label: z.string(), points: z.number(), max: z.number(), note: z.string() })),
    wouldRaise: z.array(z.string()),
  }),
  crm: z
    .object({
      exists: z.boolean(),
      ownerName: z.string().nullable(),
      lifecycle: z.enum(['none', 'open_deal', 'customer']),
      openDeals: z.number(),
    })
    .nullable(),
  warmIntro: z.object({ introducerName: z.string() }).nullable(),
  notes: z.array(z.object({ text: z.string().max(NOTE_MAX), at: z.string() })).max(INPUT_CAPS.notes),
  insights: z.string().max(INSIGHTS_MAX).nullable(),
});
export type BriefInput = z.infer<typeof briefInputSchema>;

const hasNumber = (text: string) => /\d/.test(text);

export const sectionOutputSchema = z
  .object({ text: z.string().min(1).max(SECTION_MAX), citations: z.array(z.string()) })
  .refine((s) => !hasNumber(s.text) || s.citations.length > 0, { message: CITE_MESSAGE, path: ['citations'] });
export type SectionOutput = z.infer<typeof sectionOutputSchema>;

export const briefOutputSchema = z.object({
  recommendation: z.object({ headline: z.string().min(1).max(HEADLINE_MAX), detail: z.string().min(1).max(DETAIL_MAX) }),
  sections: z.object({
    overview: sectionOutputSchema,
    approach: sectionOutputSchema,
    valueAngle: sectionOutputSchema,
    risks: sectionOutputSchema,
    whyNow: sectionOutputSchema,
  }),
  opener: z
    .object({ subject: z.string().min(1).max(SUBJECT_MAX), body: z.string().min(1).max(OPENER_MAX) })
    .refine((o) => !hasLinkOrEmail(o.subject) && !hasLinkOrEmail(o.body), { message: NO_LINKS_MESSAGE, path: ['body'] }),
  whoFirst: z.object({ personId: z.string().nullable(), title: z.string().min(1).max(200), reason: z.string().min(1).max(300) }),
});
export type BriefOutput = z.infer<typeof briefOutputSchema>;

/** Output section name for each stored key. */
export const OUTPUT_KEY = { overview: 'overview', approach: 'approach', value_angle: 'valueAngle', risks: 'risks', why_now: 'whyNow' } as const;
