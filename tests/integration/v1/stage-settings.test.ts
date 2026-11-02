import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as changesRoute } from '@/http/routes/v1/accounts/[id]/changes/route';
import { POST as accountAction } from '@/http/routes/v1/accounts/[id]/route';
import { GET as facetsRoute } from '@/http/routes/v1/accounts/facets/route';
import { GET as reviewRoute } from '@/http/routes/v1/accounts/[id]/review/route';
import { POST as assignmentAction } from '@/http/routes/v1/assignments/[id]/route';
import { GET as getStages, PUT as putStages } from '@/http/routes/v1/settings/stages/route';
import { accountReview, assignment, pipelineStage, stageChange } from '@/modules/routing/db/schema';
import { setPrincipalCacheTtl } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { auditLog, outbox } from '@/platform/db/schema';
import { call, keyFor } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';

let w: Workspace;
let other: Workspace;
let leader: string;
let seller: string;
const json = async (res: Response | Promise<Response>) => (await res).json();

type S = { key?: string; name: string; description: string | null; kind: string; trigger: string; hubspot_stage: string | null; quarter_target: number | null };
const current = async (ws: Workspace = w, who: string = ws.owner): Promise<S[]> =>
  (await json(ws.as(who, getStages, 'settings/stages'))).stages.map(({ key, name, description, kind, trigger, hubspot_stage, quarter_target }: S) => ({ key, name, description, kind, trigger, hubspot_stage, quarter_target }));
const save = (stages: unknown[], who: string = w.owner, ws: Workspace = w) => ws.as(who, putStages, 'settings/stages', 'PUT', { stages });
const NEW = { description: null, kind: 'flow', trigger: 'by_hand', hubspot_stage: null, quarter_target: null };
const keysOf = async () => (await current()).map((s) => s.key);
const stageOf = async (id: string) => (await w.run((ctx) => ctx.tx.select().from(accountReview).where(eq(accountReview.accountId, id))))[0]!.stage;
const moveTo = (id: string, stage: string) => w.as(leader, accountAction, `accounts/${id}:move-stage`, 'POST', { stage });
const historyOf = (id: string) => w.run((ctx) => ctx.tx.select().from(stageChange).where(eq(stageChange.accountId, id)));

beforeAll(async () => {
  w = await workspace('Stage Settings Co');
  other = await workspace('Other Stage Settings Co');
  leader = await w.person('leader', { name: 'Dana Leader' });
  seller = await w.person('seller', { name: 'Sam Seller' });
});
beforeEach(() => setPrincipalCacheTtl(0));
afterAll(closeDbs);

describe('PUT /settings/stages (REV-E5-S1)', () => {
  it('saves the defaults as they are, with no quarter target sent at all', async () => {
    const stages = (await current()).map(({ quarter_target: _q, ...s }) => s);
    const res = await save(stages);
    expect(res.status).toBe(200);
    expect((await res.json()).stages.map((s: { key: string }) => s.key)).toEqual(['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won', 'declined', 'back_to_nurture', 'lost']);
  });

  it('AC1: a rename shows everywhere on the next load and history keeps the old name', async () => {
    const a = await w.account('Rename Co');
    expect((await moveTo(a, 'engaged')).status).toBe(200);
    const res = await save((await current()).map((s) => (s.key === 'engaged' ? { ...s, name: 'Talking' } : s)));
    expect(res.status).toBe(200);
    const f = await json(w.as(leader, facetsRoute, 'accounts/facets'));
    expect(f.stages.map((s: { label: string }) => s.label)).toContain('Talking');
    expect(f.stages.map((s: { label: string }) => s.label)).not.toContain('Engaged');
    expect((await json(w.as(leader, reviewRoute, `accounts/${a}/review`))).stage_label).toBe('Talking');
    const changes = (await json(w.as(leader, changesRoute, `accounts/${a}/changes`))).data.filter((c: { kind: string }) => c.kind === 'stage');
    expect(changes[0]).toMatchObject({ from: 'Sent', to: 'Engaged' });
    await save((await current()).map((s) => (s.key === 'engaged' ? { ...s, name: 'Engaged' } : s)));
  });

  it('AC2: a new "Set by hand" stage before Won gets a tab and Move to stage puts an account there', async () => {
    const stages = await current();
    const res = await save([...stages.slice(0, 5), { ...NEW, name: 'Proposal' }, ...stages.slice(5)]);
    expect(res.status).toBe(200);
    const proposal = (await res.json()).stages.find((s: { name: string }) => s.name === 'Proposal');
    expect(proposal.key).toMatch(/^stg_/);
    const f = await json(w.as(leader, facetsRoute, 'accounts/facets'));
    expect(f.stages.map((s: { label: string }) => s.label)).toContain('Proposal');
    const a = await w.account('Proposal Co');
    expect((await moveTo(a, proposal.key)).status).toBe(200);
    expect(await stageOf(a)).toBe(proposal.key);
  });

  it('AC3: deleting a flow stage moves its accounts back one stage with a history row, and removes it from tabs and tracker', async () => {
    const a = await w.account('Delete Engaged Co');
    await moveTo(a, 'engaged');
    const res = await save((await current()).filter((s) => s.key !== 'engaged'));
    expect(res.status).toBe(200);
    expect(await stageOf(a)).toBe('assigned');
    const rows = await historyOf(a);
    expect(rows.find((r) => r.causeEventId === 'stage_deleted:engaged')).toMatchObject({ fromStage: 'engaged', toStage: 'assigned', fromName: 'Engaged', toName: 'Assigned' });
    expect((await json(w.as(leader, facetsRoute, 'accounts/facets'))).stages.map((s: { key: string }) => s.key)).not.toContain('engaged');
    expect((await json(w.as(leader, reviewRoute, `accounts/${a}/review`))).stages.map((s: { key: string }) => s.key)).not.toContain('engaged');
  });

  it('a deleted exit sends its accounts to where they were before, else the first stage', async () => {
    const withHistory = await w.account('Lost After Opportunity Co');
    await moveTo(withHistory, 'opportunity');
    await moveTo(withHistory, 'lost');
    const bare = await w.account('Lost Bare Co');
    await w.run((ctx) => ctx.tx.update(accountReview).set({ stage: 'lost' }).where(eq(accountReview.accountId, bare)));
    expect((await save((await current()).filter((s) => s.key !== 'lost'))).status).toBe(200);
    expect(await stageOf(withHistory)).toBe('opportunity');
    expect(await stageOf(bare)).toBe('arrived');
  });

  it('AC4: deleting the won stage, or a stage with no name, is refused with the sentence and nothing is saved', async () => {
    const before = await keysOf();
    const noWon = await save((await current()).filter((s) => s.key !== 'won'));
    expect(noWon.status).toBe(400);
    expect((await noWon.json()).errors).toContainEqual({ path: 'stages', message: 'The first stage and the won stage can be renamed but not deleted.' });
    const blank = await save((await current()).map((s) => (s.key === 'reviewed' ? { ...s, name: ' ' } : s)));
    expect(blank.status).toBe(400);
    expect((await blank.json()).errors).toEqual([{ path: 'stages.1.name', message: 'Every stage needs a name.' }]);
    expect(await keysOf()).toEqual(before);
  });

  it('AC5: two stages on one trigger are refused at the field', async () => {
    const stages = await current();
    const res = await save(stages.map((s) => (s.key === 'opportunity' ? { ...s, trigger: 'ae_accepts' } : s)));
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual([{ path: `stages.${stages.findIndex((s) => s.key === 'opportunity')}.trigger`, message: 'Only one stage can move when an AE accepts the assignment.' }]);
  });

  it('refuses the same stage twice, an unknown trigger, and a deal stage trigger without a HubSpot stage', async () => {
    const stages = await current();
    const twice = await save([stages[0], stages[0], ...stages.slice(1)]);
    expect(twice.status).toBe(400);
    expect((await twice.json()).errors).toContainEqual({ path: 'stages.1.key', message: 'That stage is in the list twice.' });
    expect((await save(stages.map((s) => (s.key === 'reviewed' ? { ...s, trigger: 'nope' } : s)))).status).toBe(400);
    const noHs = await save(stages.map((s) => (s.key === 'reviewed' ? { ...s, trigger: 'deal_reaches_stage' } : s)));
    expect((await noHs.json()).errors).toEqual([{ path: 'stages.1.hubspot_stage', message: 'A stage that moves on a HubSpot deal stage needs that HubSpot stage.' }]);
  });

  it('Review Focus 2: an account waiting on acceptance is not left on a deleted stage', async () => {
    const a = await w.account('Pending Co');
    await w.run((ctx) => ctx.tx.update(accountReview).set({ stage: 'reviewed' }).where(eq(accountReview.accountId, a)));
    expect((await w.as(leader, accountAction, `accounts/${a}:assign`, 'POST', { seller_user_id: seller })).status).toBe(202);
    expect((await save((await current()).filter((s) => s.key !== 'reviewed'))).status).toBe(200);
    expect(await stageOf(a)).toBe('arrived');
    const [open] = await w.run((ctx) => ctx.tx.select().from(assignment).where(eq(assignment.accountId, a)));
    expect((await w.as(seller, assignmentAction, `assignments/${open!.id}:accept`, 'POST')).status).toBe(200);
    expect(await stageOf(a)).toBe('assigned');
  });

  it('refuses a key that was never a stage of this workspace', async () => {
    const res = await save([...(await current()), { ...NEW, key: 'stg_nope', name: 'Ghost' }]);
    expect(res.status).toBe(400);
  });

  it('Restore defaults puts deleted defaults back under their keys and deletes the added stages', async () => {
    expect(await keysOf()).not.toContain('engaged');
    const added = (await current()).find((s) => s.name === 'Proposal')!;
    const a = await w.account('Restore Co');
    await moveTo(a, added.key!);
    const got = await json(w.as(w.owner, getStages, 'settings/stages'));
    const defaults = got.defaults.map(({ key, name, description, kind, trigger, hubspot_stage, quarter_target }: S) => ({ key, name, description, kind, trigger, hubspot_stage, quarter_target }));
    expect(defaults.map((s: S) => s.key)).toEqual(['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won', 'declined', 'back_to_nurture', 'lost']);
    expect(got.defaults[0]).toMatchObject({ trigger_label: 'A source or import creates it', locked: 'first' });
    const res = await save(defaults);
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.stages.map((s: { key: string }) => s.key)).toEqual(['arrived', 'reviewed', 'assigned', 'engaged', 'opportunity', 'won', 'declined', 'back_to_nurture', 'lost']);
    expect(view.stages.map((s: { name: string }) => s.name)).toEqual(['Sent', 'Reviewed', 'Assigned', 'Engaged', 'Opportunity', 'Won', 'Disqualified', 'Back to nurture', 'Lost']);
    expect(await stageOf(a)).toBe('opportunity');
  });

  it('audits before and after, publishes routing.stages.changed, and answers 403 without settings:manage or for an API key', async () => {
    await save((await current()).map((s) => (s.key === 'reviewed' ? { ...s, description: 'Looked at' } : s)));
    const audits = await adminDb.select().from(auditLog).where(eq(auditLog.tenantId, w.tenantId));
    const entry = audits.filter((r) => r.action === 'routing.stages.changed').at(-1)!;
    expect(entry.before).toBeTruthy();
    expect(entry.after).toBeTruthy();
    const events = (await adminDb.select().from(outbox).where(eq(outbox.tenantId, w.tenantId))).map((r) => r.payload as { type: string });
    expect(events.some((e) => e.type === 'routing.stages.changed')).toBe(true);
    expect((await save(await current(), seller)).status).toBe(403);
    expect((await call(putStages, await keyFor(w.tenant, ['settings:manage']), 'settings/stages', { method: 'PUT', body: { stages: await current() } })).status).toBe(403);
  });

  it('REV-E5-S5-AC1: another workspace keeps its own stages', async () => {
    const theirs = await current(other);
    expect(theirs.map((s) => s.name)).toEqual(['Sent', 'Reviewed', 'Assigned', 'Engaged', 'Opportunity', 'Won', 'Disqualified', 'Back to nurture', 'Lost']);
    expect(await other.run((ctx) => ctx.tx.select().from(pipelineStage).where(eq(pipelineStage.key, 'stg_none')))).toEqual([]);
  });
});
