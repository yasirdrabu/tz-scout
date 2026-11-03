import { and, eq, like, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accountIdsForWarmIntroChange,
  confirmWarmIntro,
  getArrival,
  getWarmIntroSettings,
  saveWarmIntroSettings,
  submitArrival,
  type WarmIntroSettingsInput,
} from '@/modules/intake';
import { warmIntro, warmIntroRule } from '@/modules/intake/db/schema';
import { addMember, removeMember } from '@/modules/tenancy';
import { adminDb } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { ScoutError } from '@/platform/errors';
import { runOutbox } from '../helpers/run-outbox';
import { inTenant, seedUser } from '../tenancy/helpers';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let src: { personId: string; agentId: string };
let sel: { id: string; email: string; membershipId: string };

beforeEach(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId); // relationship defaults
  src = await personAndAgent(t, 'Ash');
  const u = await seedUser({ email: `sel-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com` });
  sel = { ...u, membershipId: await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller' })) };
});

let n = 0;
const uniqueDomain = () => `wis${Date.now().toString(36)}${++n}.com`;

/** Records an intro on a new account, by the agent (unconfirmed) or the person (confirmed); returns its row. */
async function intro(warm: Record<string, unknown>, by: 'agent' | 'person' = 'agent', domain = uniqueDomain()) {
  const out = await asSource(t, by === 'agent' ? src.agentId : src.personId, (ctx) =>
    submitArrival(ctx, { account: { name: 'Warm Co', domain }, warm_intro: warm }, { channel: 'api' }),
  );
  await runOutbox(t.tenantId);
  const accountId = (await t.run((ctx) => getArrival(ctx, out.arrivalId)))!.accountId!;
  return { ...(await row(out.arrivalId)), accountId };
}
const row = async (arrivalId: string) => (await t.run((ctx) => ctx.tx.select().from(warmIntro).where(eq(warmIntro.arrivalId, arrivalId))))[0]!;

const save = (input: WarmIntroSettingsInput) => t.run((ctx) => saveWarmIntroSettings(ctx, input));
const settings = () => t.run((ctx) => getWarmIntroSettings(ctx));
/** The stored settings as a save body. */
async function asInput(): Promise<WarmIntroSettingsInput> {
  const s = await settings();
  return {
    relationships: s.relationships.map((r) => ({ key: r.key, points: r.points })),
    rules: s.rules.map((r) => ({
      id: r.id,
      introducerUserId: r.introducerUserId,
      introducerEmail: r.introducerEmail,
      introducerName: r.introducerName,
      relationshipKey: r.relationshipKey,
      points: r.points,
    })),
  };
}
const withDefault = (input: WarmIntroSettingsInput, key: string, points: number) => ({
  ...input,
  relationships: input.relationships.map((r) => (r.key === key ? { ...r, points } : r)),
});

async function repriced() {
  const rows = (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'intake.warm_intro.repriced' order by seq`,
  )) as unknown as { payload: { data: { changeId: string } } }[];
  return rows.map((r) => r.payload.data);
}

async function refused(input: WarmIntroSettingsInput): Promise<ScoutError> {
  const e = await save(input).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ScoutError);
  expect((e as ScoutError).status).toBe(400);
  return e as ScoutError;
}

describe('getWarmIntroSettings', () => {
  it('lists the six relationships with their intro counts, and each introducer once', async () => {
    await intro({ introducer_name: 'Sel', introducer_email: sel.email, relationship_key: 'employee_network' });
    await intro({ introducer_name: 'Outside Olu', introducer_email: 'Olu@Example.com', relationship_key: 'customer_referral' });
    await intro({ introducer_name: 'Outside Olu', introducer_email: 'olu@example.com', relationship_key: 'customer_referral' });
    const s = await settings();
    expect(s.relationships.map((r) => r.key)).toEqual(['customer_referral', 'partner_referral', 'board_or_investor', 'employee_network', 'event_meeting', 'other']);
    expect(s.relationships.find((r) => r.key === 'employee_network')).toEqual({ key: 'employee_network', label: 'Someone on our team knows them', points: 8, introCount: 1 });
    expect(s.relationships.find((r) => r.key === 'customer_referral')!.introCount).toBe(2);
    expect(s.rules).toEqual([]);
    expect(s.introducers.filter((i) => i.userId === sel.id)).toEqual([{ userId: sel.id, email: sel.email, name: expect.any(String), introCount: 1 }]);
    expect(s.introducers.filter((i) => i.email === 'olu@example.com')).toEqual([{ userId: null, email: 'olu@example.com', name: 'Outside Olu', introCount: 2 }]);
    expect(s.introducers.some((i) => i.userId !== null && i.introCount === 0)).toBe(true); // the owner, a member with no intros
  });
});

describe('saveWarmIntroSettings', () => {
  it('reprices unconfirmed and confirmed intros when a default changes, and stamps their accounts', async () => {
    const byAgent = await intro({ introducer_name: 'Ash', relationship_key: 'employee_network' });
    const byPerson = await intro({ introducer_name: 'Ash', relationship_key: 'employee_network' }, 'person');
    const untouched = await intro({ introducer_name: 'Ash', relationship_key: 'event_meeting' });
    expect([byAgent.points, byAgent.effectivePoints, byPerson.effectivePoints]).toEqual([8, 4, 8]);

    const out = await save(withDefault(await asInput(), 'employee_network', 10));
    expect(out.rescoringAccountCount).toBe(2);
    expect(out.settings.relationships.find((r) => r.key === 'employee_network')!.points).toBe(10);
    const [a, p, u] = await Promise.all([row(byAgent.arrivalId), row(byPerson.arrivalId), row(untouched.arrivalId)]);
    expect([a.points, a.effectivePoints, p.points, p.effectivePoints]).toEqual([10, 5, 10, 10]);
    expect(u.repricedChangeId).toBeNull();

    const events = await repriced();
    expect(events).toHaveLength(1);
    const { changeId } = events[0]!;
    expect(changeId).toMatch(/^wic_/);
    expect([a.repricedChangeId, p.repricedChangeId]).toEqual([changeId, changeId]);
    expect(await t.run((ctx) => accountIdsForWarmIntroChange(ctx, changeId, { limit: 50 }))).toEqual([byAgent.accountId, byPerson.accountId].sort());
    const first = await t.run((ctx) => accountIdsForWarmIntroChange(ctx, changeId, { limit: 1 }));
    expect(await t.run((ctx) => accountIdsForWarmIntroChange(ctx, changeId, { limit: 1, afterId: first[0] }))).toEqual(
      [byAgent.accountId, byPerson.accountId].sort().slice(1),
    );

    const audits = await t.run((ctx) =>
      ctx.tx.select().from(auditLog).where(and(eq(auditLog.tenantId, ctx.tenantId), eq(auditLog.action, 'intake.relationship_default.set'))),
    );
    expect(audits.map((x) => [x.subjectId, x.before, x.after])).toEqual([['employee_network', { points: 8 }, { points: 10 }]]);
  });

  it('publishes nothing and counts no accounts when no intro changes', async () => {
    await intro({ introducer_name: 'Ash', relationship_key: 'employee_network' });
    expect((await save(await asInput())).rescoringAccountCount).toBe(0);
    expect((await save(withDefault(await asInput(), 'partner_referral', 11))).rescoringAccountCount).toBe(0);
    expect(await repriced()).toEqual([]);
  });

  it('lets a rule beat a default edit, so rule-covered intros are not stamped, and a deleted rule falls back to the default', async () => {
    const mine = await intro({ introducer_name: 'Sel', introducer_email: sel.email, relationship_key: 'employee_network' });
    const theirs = await intro({ introducer_name: 'Bo', relationship_key: 'employee_network' });
    expect(mine.introducerUserId).toBe(sel.id);

    const ruled = await save({ ...(await asInput()), rules: [{ introducerUserId: sel.id, relationshipKey: 'employee_network', points: 12 }] });
    expect(ruled.rescoringAccountCount).toBe(1);
    expect(ruled.settings.rules).toEqual([
      { id: expect.stringMatching(/^wir_/), introducerUserId: sel.id, introducerEmail: null, introducerName: expect.any(String), relationshipKey: 'employee_network', points: 12, introCount: 1 },
    ]);
    const ruleChange = (await row(mine.arrivalId)).repricedChangeId;
    expect(await row(mine.arrivalId)).toMatchObject({ points: 12, effectivePoints: 6 });
    expect((await row(theirs.arrivalId)).repricedChangeId).toBeNull();

    const edited = await save(withDefault(await asInput(), 'employee_network', 10));
    expect(edited.rescoringAccountCount).toBe(1);
    expect(await row(mine.arrivalId)).toMatchObject({ points: 12, effectivePoints: 6, repricedChangeId: ruleChange });
    const other = await row(theirs.arrivalId);
    expect(other).toMatchObject({ points: 10, effectivePoints: 5 });
    expect(await t.run((ctx) => accountIdsForWarmIntroChange(ctx, other.repricedChangeId!, { limit: 50 }))).toEqual([theirs.accountId]);

    const dropped = await save({ ...(await asInput()), rules: [] });
    expect(dropped.rescoringAccountCount).toBe(1);
    expect(await row(mine.arrivalId)).toMatchObject({ points: 10, effectivePoints: 5 });
    expect(await repriced()).toHaveLength(3);

    const actions = await t.run((ctx) =>
      ctx.tx.select().from(auditLog).where(and(eq(auditLog.tenantId, ctx.tenantId), like(auditLog.action, 'intake.warm_intro_rule.%'))).orderBy(auditLog.id),
    );
    expect(actions.map((x) => x.action)).toEqual(['intake.warm_intro_rule.create', 'intake.warm_intro_rule.delete']);
    expect(actions[0]!.after).toMatchObject({ introducerUserId: sel.id, relationshipKey: 'employee_network', points: 12 });
  });

  it('keeps a rule by id, updating it, and matches an outside introducer by email', async () => {
    const olu = await intro({ introducer_name: 'Olu', introducer_email: 'olu@example.com', relationship_key: 'partner_referral' });
    const created = await save({
      ...(await asInput()),
      rules: [{ introducerEmail: ' Olu@Example.com ', introducerName: 'Olu', relationshipKey: 'partner_referral', points: 4 }],
    });
    const id = created.settings.rules[0]!.id;
    expect(created.settings.rules[0]).toMatchObject({ introducerEmail: 'olu@example.com', introducerName: 'Olu', introCount: 1 });
    expect(await row(olu.arrivalId)).toMatchObject({ points: 4, effectivePoints: 2 });

    const input = await asInput();
    const updated = await save({ ...input, rules: [{ ...input.rules[0]!, points: 6 }] });
    expect(updated.settings.rules.map((r) => [r.id, r.points])).toEqual([[id, 6]]);
    expect(await row(olu.arrivalId)).toMatchObject({ points: 6, effectivePoints: 3 });
    const actions = await t.run((ctx) =>
      ctx.tx.select().from(auditLog).where(and(eq(auditLog.tenantId, ctx.tenantId), like(auditLog.action, 'intake.warm_intro_rule.%'))).orderBy(auditLog.id),
    );
    expect(actions.map((x) => [x.action, x.subjectId])).toEqual([
      ['intake.warm_intro_rule.create', id],
      ['intake.warm_intro_rule.update', id],
    ]);
    expect(actions[1]!.before).toMatchObject({ points: 4 });
    expect(actions[1]!.after).toMatchObject({ points: 6 });
  });

  it('refuses a duplicate rule naming the person and relationship, and saves nothing', async () => {
    const input = withDefault(await asInput(), 'other', 7);
    const e = await refused({
      ...input,
      rules: [
        { introducerEmail: 'olu@example.com', introducerName: 'Olu Ade', relationshipKey: 'customer_referral', points: 4 },
        { introducerEmail: 'OLU@example.com', introducerName: 'Olu Ade', relationshipKey: 'customer_referral', points: 9 },
      ],
    });
    expect(e.message).toBe('Olu Ade already has a rule for referred by a current customer.');
    expect(e.errors).toEqual([{ path: 'rules[1].relationship_key', message: 'Olu Ade already has a rule for referred by a current customer.' }]);
    const s = await settings();
    expect(s.rules).toEqual([]);
    expect(s.relationships.find((r) => r.key === 'other')!.points).toBe(3);
  });

  it('refuses points outside 0 to 20 or not whole, at the field', async () => {
    const input = await asInput();
    const bad = withDefault(input, 'customer_referral', 21);
    expect((await refused(bad)).errors).toEqual([{ path: 'relationships[0].points', message: 'Points must be a whole number from 0 to 20.' }]);
    const rules = [
      { introducerUserId: sel.id, relationshipKey: 'other', points: 3 },
      { introducerUserId: sel.id, relationshipKey: 'customer_referral', points: 2.5 },
    ];
    expect((await refused({ ...input, rules })).errors).toEqual([{ path: 'rules[1].points', message: 'Points must be a whole number from 0 to 20.' }]);
  });

  it('refuses an unknown relationship, an outside rule with no name or email, and an unknown member', async () => {
    const input = await asInput();
    expect((await refused({ ...input, relationships: [{ key: 'nope', points: 3 }] })).errors![0]!.path).toBe('relationships[0].key');
    expect((await refused({ ...input, rules: [{ introducerUserId: sel.id, relationshipKey: 'nope', points: 3 }] })).errors![0]!.path).toBe('rules[0].relationship_key');
    const noEmail = await refused({ ...input, rules: [{ introducerName: 'Olu', relationshipKey: 'other', points: 3 }] });
    expect(noEmail.errors).toEqual([{ path: 'rules[0].introducer_email', message: "Enter the person's name and email." }]);
    expect((await refused({ ...input, rules: [{ introducerUserId: 'usr_nobody', relationshipKey: 'other', points: 3 }] })).errors![0]!.path).toBe(
      'rules[0].introducer_user_id',
    );
  });
});

describe('saveWarmIntroSettings, follow-ups', () => {
  it('counts an account once when two of its intros are repriced', async () => {
    const domain = uniqueDomain();
    const a = await intro({ introducer_name: 'Ash', relationship_key: 'employee_network' }, 'agent', domain);
    const b = await intro({ introducer_name: 'Bo', relationship_key: 'employee_network' }, 'person', domain);
    expect(b.accountId).toBe(a.accountId);
    const out = await save(withDefault(await asInput(), 'employee_network', 10));
    expect(out.rescoringAccountCount).toBe(1);
    expect([(await row(a.arrivalId)).effectivePoints, (await row(b.arrivalId)).effectivePoints]).toEqual([5, 10]);
  });

  it("keeps a former member's rule through later saves, with their name, but refuses a new rule for them; a null id is a new rule", async () => {
    await intro({ introducer_name: 'Sel Ahn', introducer_email: sel.email, relationship_key: 'employee_network' });
    const created = await save({ ...(await asInput()), rules: [{ id: null, introducerUserId: sel.id, relationshipKey: 'employee_network', points: 12 }] });
    const rule = created.settings.rules[0]!;
    expect(rule.id).toMatch(/^wir_/);
    await t.run((ctx) => removeMember(ctx, sel.membershipId));

    const after = await save(withDefault(await asInput(), 'other', 4));
    expect(after.settings.rules).toEqual([expect.objectContaining({ id: rule.id, introducerUserId: sel.id, introducerName: rule.introducerName, points: 12 })]);
    expect(rule.introducerName).toEqual(expect.any(String));
    const audits = await t.run((ctx) =>
      ctx.tx.select().from(auditLog).where(and(eq(auditLog.tenantId, ctx.tenantId), like(auditLog.action, 'intake.warm_intro_rule.%'))),
    );
    expect(audits.map((x) => x.action)).toEqual(['intake.warm_intro_rule.create']);

    const input = await asInput();
    const again = await refused({ ...input, rules: [...input.rules, { introducerUserId: sel.id, relationshipKey: 'other', points: 3 }] });
    expect(again.errors).toEqual([{ path: 'rules[1].introducer_user_id', message: 'Pick a person in this workspace.' }]);
  });
});

describe('final review fixes', () => {
  it('leaves out introducers with neither a user nor an email, and lists intro makers first by count, then members by name', async () => {
    await intro({ introducer_name: 'Ash Patel', relationship_key: 'employee_network' });
    await intro({ introducer_name: 'Zed', introducer_email: 'zed@example.com', relationship_key: 'other' });
    await intro({ introducer_name: 'Zed', introducer_email: 'zed@example.com', relationship_key: 'other' });
    await intro({ introducer_name: 'Amy', introducer_email: 'amy@example.com', relationship_key: 'other' });
    const s = await settings();
    expect(s.introducers.some((i) => i.name === 'Ash Patel')).toBe(false);
    expect(s.introducers.every((i) => i.userId !== null || i.email !== null)).toBe(true);
    expect(s.introducers.slice(0, 2).map((i) => [i.email, i.introCount])).toEqual([
      ['zed@example.com', 2],
      ['amy@example.com', 1],
    ]);
    const rest = s.introducers.slice(2);
    expect(rest.length).toBeGreaterThan(1); // the owner and Sel, members with no intros
    expect(rest.every((i) => i.introCount === 0 && i.userId !== null)).toBe(true);
    const names = rest.map((i) => i.name ?? '');
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('treats an intro recorded by email before the person joined as the member: a member rule reprices and stamps it, and they can confirm it', async () => {
    const joiner = await seedUser({ email: `join-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com` });
    const early = await intro({ introducer_name: 'Jo Iner', introducer_email: joiner.email, relationship_key: 'employee_network' });
    expect(early.introducerUserId).toBeNull();
    await t.run((ctx) => addMember(ctx, { email: joiner.email, role: 'seller' }));
    expect((await settings()).introducers.filter((i) => i.email === joiner.email)).toEqual([
      { userId: joiner.id, email: joiner.email, name: expect.any(String), introCount: 1 },
    ]);

    const out = await save({ ...(await asInput()), rules: [{ introducerUserId: joiner.id, relationshipKey: 'employee_network', points: 12 }] });
    expect(out.rescoringAccountCount).toBe(1);
    expect(out.settings.rules[0]!.introCount).toBe(1);
    const after = await row(early.arrivalId);
    expect(after).toMatchObject({ introducerUserId: joiner.id, points: 12, effectivePoints: 6 });
    expect(after.repricedChangeId).toMatch(/^wic_/);

    const confirmed = await inTenant(t.tenantId, { kind: 'user', id: joiner.id }, (ctx) => confirmWarmIntro(ctx, early.id, { canReview: false }));
    expect(confirmed).toMatchObject({ confirmed: true, points: 12, fullPoints: 12 });
  });

  it('a stored outside rule with no name does not block a save: it takes the name on its intros, else its email', async () => {
    await intro({ introducer_name: 'Olu Ade', introducer_email: 'olu@example.com', relationship_key: 'other' });
    await save({
      ...(await asInput()),
      rules: [
        { introducerEmail: 'olu@example.com', introducerName: 'Olu', relationshipKey: 'other', points: 4 },
        { introducerEmail: 'pat@example.com', introducerName: 'Pat', relationshipKey: 'other', points: 5 },
      ],
    });
    await t.run((ctx) => ctx.tx.update(warmIntroRule).set({ introducerName: null }).where(eq(warmIntroRule.tenantId, ctx.tenantId)));
    const named = (rules: { introducerEmail: string | null; introducerName: string | null }[]) => rules.map((r) => [r.introducerEmail, r.introducerName]).sort();
    const expected = [
      ['olu@example.com', 'Olu Ade'],
      ['pat@example.com', 'pat@example.com'],
    ];
    expect(named((await settings()).rules)).toEqual(expected);
    const input = await asInput();
    const out = await save(withDefault({ ...input, rules: input.rules.map((r) => ({ ...r, introducerName: null })) }, 'partner_referral', 9));
    expect(named(out.settings.rules)).toEqual(expected);
  });
});
