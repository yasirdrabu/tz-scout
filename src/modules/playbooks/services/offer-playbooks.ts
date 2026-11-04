import { and, asc, eq, inArray } from 'drizzle-orm';
import { getSummaries } from '@/modules/accounts';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { offerPlaybook, playbookTemplate, templateStep } from '../db/schema';

export const MAPPED_TIERS = ['act_now', 'good_fit', 'watch'] as const;
export type MappedTier = (typeof MAPPED_TIERS)[number];
export const NOT_AVAILABLE = "That playbook isn't available.";

export type OfferPlaybookView = {
  tier: MappedTier;
  playbook: { id: string; name: string; status: string; steps: number; days: number } | null;
  /** The raw subject and body of the first email step of the template's current version. */
  firstEmail: { subject: string | null; body: string | null } | null;
};

const invalid = (path: string, message: string) => new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path, message }] });

/** A template's step count, days (largest `day`) and first email at its current version. */
async function shape(ctx: ModuleContext, templateId: string, version: number) {
  const steps = await ctx.tx
    .select()
    .from(templateStep)
    .where(and(eq(templateStep.tenantId, ctx.tenantId), eq(templateStep.templateId, templateId), eq(templateStep.templateVersion, version)))
    .orderBy(asc(templateStep.order));
  const email = steps.find((s) => s.channel === 'email');
  return {
    steps: steps.length,
    days: steps.reduce((m, s) => Math.max(m, s.day), 0),
    firstEmail: email ? { subject: email.subject, body: email.body } : null,
  };
}

/** All three tiers of an offer, `playbook: null` where nothing is mapped. */
export async function offerPlaybooks(ctx: ModuleContext, offerId: string): Promise<OfferPlaybookView[]> {
  const rows = await ctx.tx
    .select({ tier: offerPlaybook.tier, template: playbookTemplate })
    .from(offerPlaybook)
    .innerJoin(playbookTemplate, eq(playbookTemplate.id, offerPlaybook.templateId))
    .where(and(eq(offerPlaybook.tenantId, ctx.tenantId), eq(offerPlaybook.offerId, offerId)));
  const out: OfferPlaybookView[] = [];
  for (const tier of MAPPED_TIERS) {
    const hit = rows.find((r) => r.tier === tier);
    if (!hit) {
      out.push({ tier, playbook: null, firstEmail: null });
      continue;
    }
    const { firstEmail, ...counts } = await shape(ctx, hit.template.id, hit.template.version);
    out.push({ tier, playbook: { id: hit.template.id, name: hit.template.name, status: hit.template.status, ...counts }, firstEmail });
  }
  return out;
}

/** Sets or clears (`null`) the playbook an offer starts for a tier. An archived or unknown template is a 400. Returns the three tiers. */
export async function setOfferPlaybook(ctx: ModuleContext, offerId: string, tier: string, templateId: string | null): Promise<OfferPlaybookView[]> {
  if (!(MAPPED_TIERS as readonly string[]).includes(tier)) throw invalid('tier', 'Use act_now, good_fit or watch.');
  const subject = { type: 'offer', id: offerId };
  if (templateId === null) {
    await ctx.tx.delete(offerPlaybook).where(and(eq(offerPlaybook.tenantId, ctx.tenantId), eq(offerPlaybook.offerId, offerId), eq(offerPlaybook.tier, tier)));
    await audit(ctx, { action: 'playbooks.offer_playbook.cleared', subject, after: { tier } });
    return offerPlaybooks(ctx, offerId);
  }
  const [t] = await ctx.tx
    .select({ status: playbookTemplate.status })
    .from(playbookTemplate)
    .where(and(eq(playbookTemplate.id, templateId), eq(playbookTemplate.tenantId, ctx.tenantId)));
  if (!t || t.status === 'archived') throw invalid('playbook_id', NOT_AVAILABLE);
  await ctx.tx
    .insert(offerPlaybook)
    .values({ tenantId: ctx.tenantId, offerId, tier, templateId, updatedBy: ctx.actor.id })
    .onConflictDoUpdate({
      target: [offerPlaybook.tenantId, offerPlaybook.offerId, offerPlaybook.tier],
      set: { templateId, updatedBy: ctx.actor.id, updatedAt: new Date() },
    });
  await audit(ctx, { action: 'playbooks.offer_playbook.set', subject, after: { tier, templateId } });
  return offerPlaybooks(ctx, offerId);
}

/** The template mapped to an offer and tier, or null. Not filtered by status: the caller decides what an archived template means. */
export async function playbookFor(ctx: ModuleContext, offerId: string, tier: string): Promise<{ templateId: string; status: string; version: number } | null> {
  const [row] = await ctx.tx
    .select({ templateId: playbookTemplate.id, status: playbookTemplate.status, version: playbookTemplate.version })
    .from(offerPlaybook)
    .innerJoin(playbookTemplate, eq(playbookTemplate.id, offerPlaybook.templateId))
    .where(and(eq(offerPlaybook.tenantId, ctx.tenantId), eq(offerPlaybook.offerId, offerId), eq(offerPlaybook.tier, tier)));
  return row ?? null;
}

export type PendingChoice = { key: string; accountId: string; offerId: string | null; templateId: string | null; noPlaybook: boolean };

/**
 * The playbook name that would start for each not-yet-accepted assignment: the assigner's pick, else the lead offer's
 * playbook for the account's tier; null when they chose none or nothing is mapped (see `startPlan`). Batched: a fixed
 * number of queries for any number of rows.
 */
export async function pendingPlaybookNames(ctx: ModuleContext, items: PendingChoice[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const open = items.filter((i) => !i.noPlaybook);
  for (const i of items) if (i.noPlaybook) out.set(i.key, null);
  if (open.length === 0) return out;
  const needTier = open.filter((i) => !i.templateId && i.offerId);
  const tiers = new Map((await getSummaries(ctx, [...new Set(needTier.map((i) => i.accountId))])).map((s) => [s.accountId, s.tier]));
  const offerIds = [...new Set(needTier.map((i) => i.offerId!))];
  const mapped = offerIds.length
    ? await ctx.tx
        .select({ offerId: offerPlaybook.offerId, tier: offerPlaybook.tier, templateId: offerPlaybook.templateId })
        .from(offerPlaybook)
        .where(and(eq(offerPlaybook.tenantId, ctx.tenantId), inArray(offerPlaybook.offerId, offerIds)))
    : [];
  const byPair = new Map(mapped.map((m) => [`${m.offerId}|${m.tier}`, m.templateId]));
  const chosen = new Map<string, string | null>();
  for (const i of open) {
    const tier = tiers.get(i.accountId);
    chosen.set(i.key, i.templateId ?? (i.offerId && tier ? (byPair.get(`${i.offerId}|${tier}`) ?? null) : null));
  }
  const templateIds = [...new Set([...chosen.values()].filter((t): t is string => !!t))];
  const names = new Map(
    (templateIds.length
      ? await ctx.tx.select({ id: playbookTemplate.id, name: playbookTemplate.name, status: playbookTemplate.status }).from(playbookTemplate).where(and(eq(playbookTemplate.tenantId, ctx.tenantId), inArray(playbookTemplate.id, templateIds)))
      : []
    ).filter((t) => t.status !== 'archived')
    .map((t) => [t.id, t.name]),
  );
  for (const [key, t] of chosen) out.set(key, t ? (names.get(t) ?? null) : null);
  return out;
}
