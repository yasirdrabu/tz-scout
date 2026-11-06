import { and, eq, gt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as exportRoute } from '@/http/routes/v1/accounts/export/route';
import { GET as facetsRoute } from '@/http/routes/v1/accounts/facets/route';
import { GET as reviewRoute } from '@/http/routes/v1/accounts/[id]/review/route';
import { GET as accountsRoute } from '@/http/routes/v1/accounts/route';
import { GET as statsRoute } from '@/http/routes/v1/sources/stats/route';
import { GET as stagesRoute } from '@/http/routes/v1/stages/route';
import { recordStage } from '@/modules/analytics';
import { stageKinds } from '@/modules/analytics/services/journeys';
import { accountReview, pipelineStage } from '@/modules/routing/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { setSummary } from '../routing/helpers';
import { call, keyFor, personAndAgent } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let other: Workspace;
let leader: string;
let src: { personId: string; agentId: string };
const json = async (res: Response | Promise<Response>) => (await res).json();

/**
 * Puts the account on `stage` in the review, the summary (it follows the review through events) and the journey
 * (the source funnel reads journeys, R3b-1 Ruling 13).
 */
const putAt = async (accountId: string, stage: string) => {
  await w.run((ctx) => ctx.tx.update(accountReview).set({ stage }).where(eq(accountReview.accountId, accountId)));
  await setSummary(w.tenant, accountId, { stage });
  await w.run(async (ctx) => recordStage(ctx, { accountId, stageKey: stage, at: new Date(), kind: (await stageKinds(ctx)).get(stage) }));
};

/** Engaged is renamed Talking and "Proposal" (set by hand) sits before Won (REV-E5-S1, as the reads see it). */
beforeAll(async () => {
  w = await workspace('Stage Reads Co');
  other = await workspace('Other Stage Reads Co');
  leader = await w.person('leader', { name: 'Dana Leader' });
  src = await personAndAgent(w.tenant, 'Stage agent');
  await w.run(async (ctx) => {
    await ctx.tx.update(pipelineStage).set({ position: sql`${pipelineStage.position} + 1` }).where(and(eq(pipelineStage.kind, 'flow'), gt(pipelineStage.position, 4)));
    await ctx.tx.update(pipelineStage).set({ name: 'Talking' }).where(eq(pipelineStage.key, 'engaged'));
    await ctx.tx.insert(pipelineStage).values({ id: newId('pst'), tenantId: ctx.tenantId, key: 'stg_proposal', name: 'Proposal', kind: 'flow', position: 5, trigger: 'by_hand' });
  });
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('reads follow the workspace stages', () => {
  let talking: string;
  let proposal: string;
  let won: string;
  let nurture: string;
  let first: string;

  beforeAll(async () => {
    first = await w.sent({ name: 'First Co' }, src.agentId);
    talking = await w.sent({ name: 'Talking Co' }, src.agentId);
    proposal = await w.sent({ name: 'Proposal Co' }, src.agentId);
    won = await w.sent({ name: 'Won Co' }, src.agentId);
    nurture = await w.sent({ name: 'Nurture Co' }, src.agentId);
    await putAt(talking, 'engaged');
    await putAt(proposal, 'stg_proposal');
    await putAt(won, 'won');
    await putAt(nurture, 'back_to_nurture');
    await setSummary(w.tenant, first, { priority: 50 });
  });

  it('REV-E5-S1-AC1/AC2: tabs are the live flow stages with their names, the added one included, and Other holds every exit', async () => {
    const f = await json(w.as(leader, facetsRoute, `accounts/facets?source_id=${src.agentId}`));
    expect(f.stages).toEqual([
      { key: 'arrived', label: 'Sent', count: 1 },
      { key: 'reviewed', label: 'Reviewed', count: 0 },
      { key: 'assigned', label: 'Assigned', count: 0 },
      { key: 'engaged', label: 'Talking', count: 1 },
      { key: 'opportunity', label: 'Opportunity', count: 0 },
      { key: 'stg_proposal', label: 'Proposal', count: 1 },
      { key: 'won', label: 'Won', count: 1 },
      { key: 'other', label: 'Other', count: 1 },
    ]);
    const others = await json(w.as(leader, accountsRoute, `accounts?source_id=${src.agentId}&stage=other`));
    expect(others.data.map((r: { account_id: string }) => r.account_id)).toEqual([nurture]);
    expect(others.data[0].stage_label).toBe('Back to nurture');
  });

  it('sorts by the workspace order, exits last', async () => {
    const body = await json(w.as(leader, accountsRoute, `accounts?source_id=${src.agentId}&sort=stage_priority`));
    expect(body.data.map((r: { account_id: string }) => r.account_id)).toEqual([first, talking, proposal, won, nurture]);
    expect(body.data.map((r: { stage_label: string }) => r.stage_label)).toEqual(['Sent', 'Talking', 'Proposal', 'Won', 'Back to nurture']);
  });

  it('shows the new names in the CSV and the tracker (a step for the added stage, the exit only for an account in it)', async () => {
    const csv = await (await w.as(leader, exportRoute, `accounts/export?source_id=${src.agentId}&sort=stage_priority`)).text();
    const lines = csv.trim().split('\r\n');
    expect(lines.map((l) => l.split(',')[5])).toEqual(['Stage', 'Sent', 'Talking', 'Proposal', 'Won', 'Back to nurture']);
    const tracker = await json(w.as(leader, reviewRoute, `accounts/${talking}/review`));
    expect(tracker.stage_label).toBe('Talking');
    expect(tracker.stages.map((s: { key: string; label: string }) => [s.key, s.label])).toEqual([
      ['arrived', 'Sent'], ['reviewed', 'Reviewed'], ['assigned', 'Assigned'], ['engaged', 'Talking'], ['opportunity', 'Opportunity'], ['stg_proposal', 'Proposal'], ['won', 'Won'],
    ]);
    const exit = await json(w.as(leader, reviewRoute, `accounts/${nurture}/review`));
    expect(exit.stages.at(-1)).toMatchObject({ key: 'back_to_nurture', label: 'Back to nurture', current: true });
  });

  it('an archived stage is gone from the tabs and the tracker', async () => {
    await w.run((ctx) => ctx.tx.update(pipelineStage).set({ archivedAt: new Date() }).where(eq(pipelineStage.key, 'opportunity')));
    const f = await json(w.as(leader, facetsRoute, `accounts/facets?source_id=${src.agentId}`));
    expect(f.stages.map((s: { key: string }) => s.key)).not.toContain('opportunity');
    const tracker = await json(w.as(leader, reviewRoute, `accounts/${talking}/review`));
    expect(tracker.stages.map((s: { key: string }) => s.key)).not.toContain('opportunity');
    await w.run((ctx) => ctx.tx.update(pipelineStage).set({ archivedAt: null }).where(eq(pipelineStage.key, 'opportunity')));
  });

  it('the source funnel lists the workspace stages, with Assigned at or past the acceptance stage', async () => {
    const body = await json(w.as(w.owner, statsRoute, 'sources/stats'));
    const ofAgent = body.data.find((s: { source_id: string }) => s.source_id === src.agentId);
    expect(ofAgent.by_stage.map((b: { key: string }) => b.key)).toEqual(['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'stg_proposal', 'won', 'declined', 'back_to_nurture', 'lost']);
    expect(ofAgent.by_stage.find((b: { key: string }) => b.key === 'engaged')).toMatchObject({ label: 'Talking', count: 1 });
    expect(ofAgent).toMatchObject({ sent: 5, assigned: 3, won: 1 });
  });

  it('GET /stages lists the live stages in order with trigger labels, and the triggers', async () => {
    const body = await json(w.as(leader, stagesRoute, 'stages'));
    expect(body.stages.map((s: { key: string }) => s.key)).toEqual(['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'stg_proposal', 'won', 'declined', 'back_to_nurture', 'lost']);
    expect(body.stages[3]).toMatchObject({ name: 'Talking', kind: 'flow', trigger: 'reply_or_meeting', trigger_label: 'A reply or meeting is logged', hubspot_stage: null, quarter_target: null, locked: null });
    expect(body.stages[0]).toMatchObject({ locked: 'first' });
    expect(body.triggers).toHaveLength(12);
    expect(body.triggers[0]).toEqual({ key: 'source_creates', label: 'A source or import creates it', limit: 'first' });
    expect((await call(stagesRoute, await keyFor(w.tenant, ['status:read']), 'stages')).status).toBe(200);
    expect((await call(stagesRoute, await keyFor(w.tenant, ['review:act']), 'stages')).status).toBe(403);
  });

  it('REV-E5-S5-AC1: another workspace sees none of it', async () => {
    const f = await json(other.as(other.owner, facetsRoute, 'accounts/facets'));
    expect(f.stages.map((s: { label: string }) => s.label)).toEqual(['Sent', 'Reviewed', 'Assigned', 'Engaged', 'Opportunity', 'Won', 'Other']);
  });
});
