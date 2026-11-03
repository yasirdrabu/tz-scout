import { and, asc, eq } from 'drizzle-orm';
import { members } from '@/modules/tenancy';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { warmIntroRepriced } from '../contracts/events';
import { relationshipDefault, warmIntro, warmIntroRule } from '../db/schema';
import { RELATIONSHIP_DEFAULTS } from '../defaults';
import { pickRule } from '../domain/warm-intro';
import { loadDefaults, repriceWarmIntros } from './warm-intros';

export type RelationshipDefaultView = { relationshipKey: string; label: string; points: number };

export type WarmIntroSettings = {
  relationships: { key: string; label: string; points: number; introCount: number }[];
  rules: {
    id: string;
    introducerUserId: string | null;
    introducerEmail: string | null;
    introducerName: string | null;
    relationshipKey: string;
    points: number;
    introCount: number;
  }[];
  /** Everyone a rule can name: the workspace's members and the people recorded intros came from, each once. */
  introducers: { userId: string | null; email: string | null; name: string | null; introCount: number }[];
};

/** A whole Warm intros tab to save (SRC-E5-S2). Rules replace the stored ones: a stored rule left out is deleted, one with no id is new. */
export type WarmIntroSettingsInput = {
  relationships: { key: string; points: number }[];
  rules: {
    id?: string | null;
    introducerUserId?: string | null;
    introducerEmail?: string | null;
    introducerName?: string | null;
    relationshipKey: string;
    points: number;
  }[];
};

const MAX_POINTS = 20;
const POINTS_MESSAGE = `Points must be a whole number from 0 to ${MAX_POINTS}.`;
const NAME_AND_EMAIL = "Enter the person's name and email.";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORDER = RELATIONSHIP_DEFAULTS.map((d) => d.relationshipKey);

const view = (r: typeof relationshipDefault.$inferSelect): RelationshipDefaultView => ({
  relationshipKey: r.relationshipKey,
  label: r.label,
  points: r.points,
});

const validPoints = (p: number) => Number.isInteger(p) && p >= 0 && p <= MAX_POINTS;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const validation = (errors: { path: string; message: string }[]) => new ScoutError({ slug: 'validation', status: 400, title: errors[0]!.message, errors });

export async function listRelationshipDefaults(ctx: ModuleContext): Promise<RelationshipDefaultView[]> {
  const rows = await ctx.tx
    .select()
    .from(relationshipDefault)
    .where(eq(relationshipDefault.tenantId, ctx.tenantId))
    .orderBy(asc(relationshipDefault.relationshipKey));
  return rows.map(view);
}

/** The Warm intros tab (§21i): the relationships' points, the introducer rules, and the people a rule can name, with intro counts. */
export async function getWarmIntroSettings(ctx: ModuleContext): Promise<WarmIntroSettings> {
  const defaults = await loadDefaults(ctx);
  const rules = await ctx.tx.select().from(warmIntroRule).where(eq(warmIntroRule.tenantId, ctx.tenantId)).orderBy(asc(warmIntroRule.id));
  const intros = await ctx.tx
    .select({ userId: warmIntro.introducerUserId, email: warmIntro.introducerEmail, name: warmIntro.introducerName, relationshipKey: warmIntro.relationshipKey })
    .from(warmIntro)
    .where(eq(warmIntro.tenantId, ctx.tenantId))
    .orderBy(asc(warmIntro.createdAt));
  const people = await members(ctx);
  const memberName = new Map(people.map((m) => [m.userId, m.name]));
  // A former member keeps a name: the one stored on their rule, else the one on their first recorded intro.
  const introName = new Map<string, string>();
  for (const i of intros) if (i.userId && i.name && !introName.has(i.userId)) introName.set(i.userId, i.name);

  const byRelationship = new Map<string, number>();
  const byRule = new Map<string, number>();
  const introducers = new Map<string, WarmIntroSettings['introducers'][number]>();
  for (const m of people) {
    const entry = { userId: m.userId, email: m.email.toLowerCase(), name: m.name, introCount: 0 };
    introducers.set(`u:${m.userId}`, entry);
    introducers.set(`e:${entry.email}`, entry);
  }
  for (const i of intros) {
    byRelationship.set(i.relationshipKey, (byRelationship.get(i.relationshipKey) ?? 0) + 1);
    const rule = pickRule(
      rules.filter((r) => r.relationshipKey === i.relationshipKey),
      i,
    );
    if (rule) byRule.set(rule.id, (byRule.get(rule.id) ?? 0) + 1);
    const keys = [i.userId && `u:${i.userId}`, i.email && `e:${i.email}`, !i.userId && !i.email && i.name && `n:${i.name.trim().toLowerCase()}`].filter(
      (k): k is string => !!k,
    );
    if (keys.length === 0) continue;
    let entry = keys.map((k) => introducers.get(k)).find((e) => e !== undefined);
    if (!entry) {
      entry = { userId: i.userId, email: i.email, name: i.name, introCount: 0 };
      for (const k of keys) introducers.set(k, entry);
    }
    entry.introCount++;
  }

  const rank = (key: string) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
  return {
    relationships: [...defaults]
      .sort((a, b) => rank(a.relationshipKey) - rank(b.relationshipKey) || a.relationshipKey.localeCompare(b.relationshipKey))
      .map((d) => ({ key: d.relationshipKey, label: d.label, points: d.points, introCount: byRelationship.get(d.relationshipKey) ?? 0 })),
    rules: rules.map((r) => ({
      id: r.id,
      introducerUserId: r.introducerUserId,
      introducerEmail: r.introducerEmail,
      introducerName: (r.introducerUserId ? memberName.get(r.introducerUserId) : undefined) ?? r.introducerName ?? (r.introducerUserId ? introName.get(r.introducerUserId) : undefined) ?? null,
      relationshipKey: r.relationshipKey,
      points: r.points,
      introCount: byRule.get(r.id) ?? 0,
    })),
    introducers: [...new Set(introducers.values())].sort(
      (a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿') || (a.email ?? '').localeCompare(b.email ?? ''),
    ),
  };
}

type RuleRow = typeof warmIntroRule.$inferSelect;
const ruleAudit = (r: RuleRow) => ({
  introducerUserId: r.introducerUserId,
  introducerEmail: r.introducerEmail,
  introducerName: r.introducerName,
  relationshipKey: r.relationshipKey,
  points: r.points,
});
/** What makes a rule changed: a member's stored name follows the member list, so it alone is not an edit. */
const ruleIdentity = (r: RuleRow) => ({ ...ruleAudit(r), introducerName: r.introducerUserId ? null : r.introducerName });

/**
 * Saves the whole Warm intros tab (SRC-E5-S2): validates it (400 with each field's sentence, nothing saved), updates the
 * relationship points, replaces the introducer rules, then reprices the intros already recorded (Ruling 2). Audits each
 * changed default and each created, updated or deleted rule. Publishes `intake.warm_intro.repriced` only when an intro's
 * points moved; `rescoringAccountCount` is how many accounts those intros are on. The tenant's relationship rows are
 * locked first, so two saves run one after the other.
 */
export async function saveWarmIntroSettings(
  ctx: ModuleContext,
  input: WarmIntroSettingsInput,
): Promise<{ settings: WarmIntroSettings; rescoringAccountCount: number }> {
  const defaults = await loadDefaults(ctx, 'update');
  const stored = await ctx.tx.select().from(warmIntroRule).where(eq(warmIntroRule.tenantId, ctx.tenantId));
  const people = new Map((await members(ctx)).map((m) => [m.userId, m.name]));
  const labels = new Map(defaults.map((d) => [d.relationshipKey, d.label]));
  const storedById = new Map(stored.map((r) => [r.id, r]));

  const errors: { path: string; message: string }[] = [];
  const seenKeys = new Set<string>();
  input.relationships.forEach((r, i) => {
    if (!labels.has(r.key)) errors.push({ path: `relationships[${i}].key`, message: 'Pick a relationship from the list.' });
    else if (seenKeys.has(r.key)) errors.push({ path: `relationships[${i}].key`, message: 'That relationship is listed twice.' });
    seenKeys.add(r.key);
    if (!validPoints(r.points)) errors.push({ path: `relationships[${i}].points`, message: POINTS_MESSAGE });
  });

  const rules: RuleRow[] = [];
  const seenRules = new Set<string>();
  const seenIds = new Set<string>();
  input.rules.forEach((r, i) => {
    const at = (field: string) => `rules[${i}].${field}`;
    const problems = errors.length;
    const id = r.id ?? undefined;
    if (id !== undefined && (!storedById.has(id) || seenIds.has(id))) errors.push({ path: at('id'), message: 'That rule was not found.' });
    if (id) seenIds.add(id);
    const before = id ? storedById.get(id) : undefined;
    const userId = r.introducerUserId || null;
    const email = userId ? null : r.introducerEmail?.trim().toLowerCase() || null;
    // A member's name is kept on their rule too, so the rule still has one if they leave.
    const name = userId ? (people.get(userId) ?? before?.introducerName ?? null) : r.introducerName?.trim() || null;
    // A stored rule keeps its person after they leave the workspace; a new or changed one must name a current member.
    const sameUser = before?.introducerUserId === userId;
    if (userId && !people.has(userId) && !sameUser) errors.push({ path: at('introducer_user_id'), message: 'Pick a person in this workspace.' });
    if (!userId && (!email || !EMAIL.test(email))) errors.push({ path: at('introducer_email'), message: NAME_AND_EMAIL });
    else if (!userId && !name) errors.push({ path: at('introducer_name'), message: NAME_AND_EMAIL });
    const label = labels.get(r.relationshipKey);
    if (!label) errors.push({ path: at('relationship_key'), message: 'Pick a relationship from the list.' });
    if (!validPoints(r.points)) errors.push({ path: at('points'), message: POINTS_MESSAGE });
    if (errors.length > problems) return;
    const who = `${userId ? `u:${userId}` : `e:${email}`}|${r.relationshipKey}`;
    if (seenRules.has(who)) {
      const message = `${name ?? email} already has a rule for ${lowerFirst(label!)}.`;
      errors.push({ path: at('relationship_key'), message });
      return;
    }
    seenRules.add(who);
    rules.push({
      id: id ?? newId('wir'),
      tenantId: ctx.tenantId,
      introducerUserId: userId,
      introducerEmail: email,
      introducerName: name,
      relationshipKey: r.relationshipKey,
      points: r.points,
    });
  });
  if (errors.length > 0) throw validation(errors);

  for (const r of input.relationships) {
    const before = defaults.find((d) => d.relationshipKey === r.key)!;
    if (before.points === r.points) continue;
    await ctx.tx
      .update(relationshipDefault)
      .set({ points: r.points })
      .where(and(eq(relationshipDefault.tenantId, ctx.tenantId), eq(relationshipDefault.relationshipKey, r.key)));
    await audit(ctx, {
      action: 'intake.relationship_default.set',
      subject: { type: 'relationship_default', id: r.key },
      before: { points: before.points },
      after: { points: r.points },
    });
  }

  // Rules are replaced whole (keeping their ids), so a swap of introducer or relationship never trips the unique indexes.
  await ctx.tx.delete(warmIntroRule).where(eq(warmIntroRule.tenantId, ctx.tenantId));
  if (rules.length > 0) await ctx.tx.insert(warmIntroRule).values(rules);
  const kept = new Set(rules.map((r) => r.id));
  for (const r of stored) {
    if (!kept.has(r.id)) await audit(ctx, { action: 'intake.warm_intro_rule.delete', subject: { type: 'warm_intro_rule', id: r.id }, before: ruleAudit(r) });
  }
  for (const r of rules) {
    const before = storedById.get(r.id);
    const subject = { type: 'warm_intro_rule', id: r.id };
    if (!before) await audit(ctx, { action: 'intake.warm_intro_rule.create', subject, after: ruleAudit(r) });
    else if (JSON.stringify(ruleIdentity(before)) !== JSON.stringify(ruleIdentity(r))) {
      await audit(ctx, { action: 'intake.warm_intro_rule.update', subject, before: ruleAudit(before), after: ruleAudit(r) });
    }
  }

  const { changeId, accountIds } = await repriceWarmIntros(ctx);
  if (accountIds.length > 0) await publish(ctx, warmIntroRepriced, { changeId });
  return { settings: await getWarmIntroSettings(ctx), rescoringAccountCount: accountIds.length };
}
