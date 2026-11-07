import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as whatWorkedRoute } from '@/http/routes/v1/analytics/what-worked/route';
import { analyticsJourneyMerge, analyticsJourneyScore, analyticsStepCredit, whatWorked } from '@/modules/analytics';
import { stepCredit } from '@/modules/analytics/db/schema';
import { accountPlan, planStep, playbookTemplate } from '@/modules/playbooks/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import type { ConsumerDef } from '@/platform/runtime/consumers';
import { setSummary } from '../routing/helpers';
import { call, keyFor } from '../v1/intake-helpers';
import { workspace, type Workspace } from '../v1/review-helpers';

afterAll(closeDbs);
beforeEach(() => setPrincipalCacheTtl(0));

const NOW = new Date('2026-11-07T12:00:00.000Z');
const at = (day: string, time = '10:00') => `${day}T${time}:00.000Z`;

function deliver<D>(w: Workspace, c: ConsumerDef<D>, data: D, occurredAt: string): Promise<void> {
  return w.run((ctx) =>
    c.handle(
      { id: newId('evt'), type: c.event.type, schemaVersion: 1, tenantId: w.tenantId, occurredAt, actor: { kind: 'system', id: 'test' }, correlationId: newId('cor'), data: c.event.data.parse(data) },
      ctx,
    ),
  );
}

type Channel = 'email' | 'linkedin' | 'call' | 'meeting' | 'task';
type Credited = { stepId: string; channel: Channel };
const outcomeEvent = (accountId: string, templateId: string | null, kind: string, day: string, credited: Credited[], outcomeId = newId('out')) => ({
  outcomeId,
  accountId,
  planId: newId('pln'),
  templateId,
  kind,
  occurredAt: at(day),
  source: 'crm' as const,
  amountCents: null,
  creditedStepIds: credited.map((c) => c.stepId),
  creditedSteps: credited,
});
const credit = (w: Workspace, e: ReturnType<typeof outcomeEvent>) => deliver(w, analyticsStepCredit, e as never, e.occurredAt);

const json = async (p: Promise<Response>, status = 200) => {
  const res = await p;
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
};

async function atNow<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

const counts = (reply = 0, meeting = 0, opportunity = 0, won = 0) => ({ reply, meeting, opportunity, won });

let w: Workspace;
let ann: string;
let t1: string;
let t2: string;
let a1: string;
let a2: string;
let a3: string;
const stepIds = new Map<string, string>();

/**
 * Template T1: Ann's a1 (email 11-01, call 11-03, and an email done in June) and a2 (email 11-02, email 11-04).
 * Template T2: Bob's a3 (email 11-05, linkedin 11-05).
 * Outcomes: a1 reply 11-04 credits a1's email and call; a2 meeting 11-05 credits a2's first email; a1 won 11-06 has no
 * recent step; a3 reply 11-06 credits a3's email and linkedin; a2 lost 11-06 (not counted); a1 reply 2026-07-01 is too old.
 */
beforeAll(async () => {
  w = await workspace('What Worked Co');
  ann = await w.person('seller', { name: 'Ann Seller', dataLimit: { kind: 'own_accounts' } });
  const bob = await w.person('seller', { name: 'Bob Seller' });
  [a1, a2, a3] = (await Promise.all([1, 2, 3].map((i) => w.account(`What Worked Co ${i}`)))) as [string, string, string];
  for (const a of [a1, a2]) await setSummary(w.tenant, a, { ownerUserId: ann });
  await setSummary(w.tenant, a3, { ownerUserId: bob });

  await w.run(async (ctx) => {
    t1 = newId('plb');
    t2 = newId('plb');
    await ctx.tx.insert(playbookTemplate).values([
      { id: t1, tenantId: ctx.tenantId, name: 'Standard' },
      { id: t2, tenantId: ctx.tenantId, name: 'Other' },
    ]);
    const plan = async (accountId: string, templateId: string) => {
      const id = newId('pln');
      await ctx.tx.insert(accountPlan).values({ id, tenantId: ctx.tenantId, accountId, templateId, templateVersion: 1, assignmentId: newId('asg'), stopWhen: 'reply_or_meeting', startDate: '2026-10-01' });
      return id;
    };
    const rows: (typeof planStep.$inferInsert)[] = [];
    const step = (key: string, planId: string, order: number, channel: Channel, doneAt: string) => {
      const id = newId('stp');
      stepIds.set(key, id);
      rows.push({ id, tenantId: ctx.tenantId, planId, order, day: 0, channel, ownerRole: 'seller', title: key, dueDate: '2026-11-01', status: 'done', doneAt: new Date(doneAt) });
    };
    const p1 = await plan(a1, t1);
    const p2 = await plan(a2, t1);
    const p3 = await plan(a3, t2);
    step('a1-email', p1, 1, 'email', at('2026-11-01'));
    step('a1-call', p1, 2, 'call', at('2026-11-03'));
    step('a1-old', p1, 3, 'email', at('2026-06-01'));
    step('a2-email1', p2, 1, 'email', at('2026-11-02'));
    step('a2-email2', p2, 2, 'email', at('2026-11-04'));
    step('a3-email', p3, 1, 'email', at('2026-11-05'));
    step('a3-linkedin', p3, 2, 'linkedin', at('2026-11-05'));
    await ctx.tx.insert(planStep).values(rows);
  });

  const s = (k: string, channel: Channel): Credited => ({ stepId: stepIds.get(k)!, channel });
  await credit(w, outcomeEvent(a1, t1, 'reply', '2026-11-04', [s('a1-email', 'email'), s('a1-call', 'call')]));
  await credit(w, outcomeEvent(a2, t1, 'meeting', '2026-11-05', [s('a2-email1', 'email')]));
  await credit(w, outcomeEvent(a1, t1, 'won', '2026-11-06', []));
  await credit(w, outcomeEvent(a3, t2, 'reply', '2026-11-06', [s('a3-email', 'email'), s('a3-linkedin', 'linkedin')]));
  await credit(w, outcomeEvent(a2, t1, 'lost', '2026-11-06', [s('a2-email2', 'email')]));
  await credit(w, outcomeEvent(a1, t1, 'reply', '2026-07-01', [s('a1-old', 'email')]));
});

describe('analytics.step_credit consumer', () => {
  let s: Workspace;
  beforeAll(async () => {
    s = await workspace('Credit Side Co');
  });
  const rowsOf = (a: string) => s.run((ctx) => ctx.tx.select().from(stepCredit).where(eq(stepCredit.accountId, a)));

  it('an outcome event writes one row per credited step with practice and offer from the journey', async () => {
    const acc = await s.account('Journey Credit Co');
    await deliver(
      s,
      analyticsJourneyScore,
      { accountId: acc, priority: 70, fit: 60, intent: 50, tier: 'good_fit', previousTier: null, bestOfferId: 'off_x', previousBestOfferId: null, practiceId: 'prc_x', revenueBand: null, cause: 'new_signal', profileVersion: 1, version: 1_000_000 },
      at('2026-11-01'),
    );
    const e = outcomeEvent(acc, t1, 'reply', '2026-11-04', [{ stepId: 'stp_1', channel: 'email' }, { stepId: 'stp_2', channel: 'call' }]);
    await credit(s, e);
    const rows = await rowsOf(acc);
    expect(rows.map((r) => [r.stepId, r.stepType]).sort()).toEqual([['stp_1', 'email'], ['stp_2', 'call']]);
    expect(rows.every((r) => r.practiceId === 'prc_x' && r.offerId === 'off_x' && r.outcomeKind === 'reply' && r.playbookTemplateId === t1 && r.outcomeId === e.outcomeId)).toBe(true);
    expect(rows[0]!.occurredAt).toEqual(new Date(at('2026-11-04')));
  });

  it('an outcome with no credited step writes one null-step row, with null practice and offer without a journey', async () => {
    const acc = await s.account('No Step Co');
    await credit(s, outcomeEvent(acc, t1, 'won', '2026-11-04', []));
    const rows = await rowsOf(acc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stepId: null, stepType: null, practiceId: null, offerId: null, outcomeKind: 'won' });
  });

  it('a replayed event adds no rows, with or without credited steps', async () => {
    const acc = await s.account('Replay Co');
    const withSteps = outcomeEvent(acc, t1, 'reply', '2026-11-04', [{ stepId: 'stp_r1', channel: 'email' }]);
    const without = outcomeEvent(acc, t1, 'won', '2026-11-04', []);
    for (const e of [withSteps, without]) {
      await credit(s, e);
      await credit(s, e);
    }
    expect(await rowsOf(acc)).toHaveLength(2);
  });

  it('merge moves credit rows to the survivor, and running it again changes nothing', async () => {
    const survivor = await s.account('Survivor Co');
    const merged = await s.account('Merged Co');
    await credit(s, outcomeEvent(merged, t1, 'reply', '2026-11-04', [{ stepId: 'stp_m1', channel: 'email' }]));
    const merge = () => deliver(s, analyticsJourneyMerge, { survivorId: survivor, mergedId: merged, mergedBy: 'usr_1' }, at('2026-11-05'));
    await merge();
    await merge();
    expect(await rowsOf(merged)).toHaveLength(0);
    expect((await rowsOf(survivor)).map((r) => r.stepId)).toEqual(['stp_m1']);
  });

  it('RLS: another tenant reads no rows', async () => {
    const other = await workspace('Other Credit Co');
    expect(await other.run((ctx) => ctx.tx.select().from(stepCredit))).toEqual([]);
    expect((await w.run((ctx) => ctx.tx.select().from(stepCredit))).length).toBeGreaterThan(0);
  });
});

describe('whatWorked', () => {
  it('matches a hand count for scripted outcomes (ANL-E4-S3-AC2)', async () => {
    const v = await w.run((ctx) => whatWorked(ctx, {}, { now: NOW }));
    expect(v.minSteps).toBe(10);
    expect(v.noRecentStep).toEqual(counts(0, 0, 0, 1));
    expect(v.rows).toEqual([
      { stepType: 'email', stepsDone: 4, counts: counts(2, 1), per10: { reply: 5, meeting: 2.5, opportunity: 0, won: 0 } },
      { stepType: 'linkedin', stepsDone: 1, counts: counts(1), per10: { reply: 10, meeting: 0, opportunity: 0, won: 0 } },
      { stepType: 'call', stepsDone: 1, counts: counts(1), per10: { reply: 10, meeting: 0, opportunity: 0, won: 0 } },
    ]);
  });

  it('templateId filters both counts', async () => {
    const v = await w.run((ctx) => whatWorked(ctx, { templateId: t1 }, { now: NOW }));
    expect(v.rows.map((r) => [r.stepType, r.stepsDone, r.counts])).toEqual([
      ['email', 3, counts(1, 1)],
      ['call', 1, counts(1)],
    ]);
    expect(v.noRecentStep).toEqual(counts(0, 0, 0, 1));
    const v2 = await w.run((ctx) => whatWorked(ctx, { templateId: t2 }, { now: NOW }));
    expect(v2.rows.map((r) => [r.stepType, r.stepsDone])).toEqual([['email', 1], ['linkedin', 1]]);
    expect(v2.noRecentStep).toEqual(counts());
  });

  it('credits older than 90 days are left out', async () => {
    // the June reply credits a1-old; with a later now the 11-04 reply falls out too
    const later = await w.run((ctx) => whatWorked(ctx, { templateId: t1 }, { now: new Date('2027-03-01T12:00:00.000Z') }));
    expect(later.rows).toEqual([]);
    const june = await w.run((ctx) => whatWorked(ctx, { templateId: t1 }, { now: new Date('2026-07-02T12:00:00.000Z') }));
    expect(june.rows.map((r) => [r.stepType, r.stepsDone, r.counts.reply])).toEqual([['email', 1, 1]]);
  });

  it('under own_accounts only the seller\'s accounts count, both sides', async () => {
    const body = await atNow(() => json(w.as(ann, whatWorkedRoute, 'analytics/what-worked')));
    expect(body.rows).toEqual([
      { step_type: 'email', steps_done: 3, counts: counts(1, 1), per_10: { reply: 3.3, meeting: 3.3, opportunity: 0, won: 0 } },
      { step_type: 'call', steps_done: 1, counts: counts(1), per_10: { reply: 10, meeting: 0, opportunity: 0, won: 0 } },
    ]);
    expect(body.no_recent_step).toEqual(counts(0, 0, 0, 1));
  });
});

describe('GET /api/v1/analytics/what-worked', () => {
  it('returns snake_case, updated_at, and filters by template_id', async () => {
    const body = await atNow(() => json(w.as(w.owner, whatWorkedRoute, `analytics/what-worked?template_id=${t2}`)));
    expect(body).toEqual({
      rows: [
        { step_type: 'email', steps_done: 1, counts: counts(1), per_10: { reply: 10, meeting: 0, opportunity: 0, won: 0 } },
        { step_type: 'linkedin', steps_done: 1, counts: counts(1), per_10: { reply: 10, meeting: 0, opportunity: 0, won: 0 } },
      ],
      no_recent_step: counts(),
      min_steps: 10,
      updated_at: at('2026-11-06'),
    });
  });

  it('an empty workspace has no rows and a null updated_at', async () => {
    const empty = await workspace('Empty What Worked Co');
    const body = await atNow(() => json(empty.as(empty.owner, whatWorkedRoute, 'analytics/what-worked')));
    expect(body).toEqual({ rows: [], no_recent_step: counts(), min_steps: 10, updated_at: null });
  });

  it('is 401 without auth and 403 without analytics:read', async () => {
    expect((await whatWorkedRoute(new Request('http://x/api/v1/analytics/what-worked'))).status).toBe(401);
    const noRead = await keyFor(w.tenant, ['accounts:read']);
    expect((await call(whatWorkedRoute, noRead, 'analytics/what-worked')).status).toBe(403);
  });
});
