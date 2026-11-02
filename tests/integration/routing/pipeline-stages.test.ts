import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { seedRoutingDefaults } from '@/modules/routing';
import { pipelineStage } from '@/modules/routing/db/schema';
import { DEFAULT_STAGES } from '@/modules/routing/domain/pipeline';
import { loadStageNames, loadStages } from '@/modules/routing/services/pipeline-stages';
import { closeDbs } from '@/platform/db/client';
import { migrateAll, migrationsFolder } from '@/platform/db/migrate';
import { freshDatabase } from '../helpers/db';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

describe('pipeline stages per workspace', () => {
  let a: Awaited<ReturnType<typeof freshTenant>>;
  let b: Awaited<ReturnType<typeof freshTenant>>;
  beforeAll(async () => {
    a = await freshTenant();
    b = await freshTenant();
  });
  afterAll(closeDbs);

  it('seeds the default stages for a new workspace, once however often it runs', async () => {
    await runOutbox(a.tenantId);
    expect(await a.run((ctx) => loadStages(ctx))).toEqual(DEFAULT_STAGES);
    await a.run((ctx) => seedRoutingDefaults(ctx));
    expect(await a.run((ctx) => ctx.tx.select().from(pipelineStage))).toHaveLength(DEFAULT_STAGES.length);
  });

  it('keeps a changed stage when seeding runs again', async () => {
    await a.run((ctx) => ctx.tx.update(pipelineStage).set({ name: 'Talking' }).where(eq(pipelineStage.key, 'engaged')));
    await a.run((ctx) => seedRoutingDefaults(ctx));
    expect((await a.run((ctx) => loadStages(ctx))).find((s) => s.key === 'engaged')?.name).toBe('Talking');
  });

  it('REV-E5-S5-AC1: one workspace never sees the other’s stages', async () => {
    await runOutbox(b.tenantId);
    expect((await b.run((ctx) => loadStages(ctx))).find((s) => s.key === 'engaged')?.name).toBe('Engaged');
    expect(await b.run((ctx) => ctx.tx.select().from(pipelineStage).where(eq(pipelineStage.tenantId, a.tenantId)))).toEqual([]);
    await expect(
      b.run((ctx) => ctx.tx.transaction((sp) => sp.insert(pipelineStage).values({ id: 'pst_x', tenantId: a.tenantId, key: 'x', name: 'X', kind: 'flow', position: 9, trigger: 'by_hand' }))),
    ).rejects.toThrow();
  });

  it('leaves archived stages out of the list but names them for history', async () => {
    await b.run((ctx) => ctx.tx.update(pipelineStage).set({ archivedAt: new Date() }).where(eq(pipelineStage.key, 'back_to_nurture')));
    expect((await b.run((ctx) => loadStages(ctx))).map((s) => s.key)).not.toContain('back_to_nurture');
    expect((await b.run((ctx) => loadStageNames(ctx))).get('back_to_nurture')).toBe('Back to nurture');
  });

  it('refuses two live stages with the same name, in any case', async () => {
    await expect(a.run((ctx) => ctx.tx.transaction((sp) => sp.update(pipelineStage).set({ name: 'reviewed' }).where(eq(pipelineStage.key, 'assigned'))))).rejects.toThrow();
  });

  it('falls back to the defaults for a workspace whose defaults have not been delivered', async () => {
    const fresh = await freshTenant();
    expect(await fresh.run((ctx) => loadStages(ctx))).toEqual(DEFAULT_STAGES);
  });
});

/** The routing migrations up to and including `lastTag`, as their own folder. */
function routingUpTo(lastTag: string): string {
  const real = migrationsFolder('routing');
  const journal = JSON.parse(readFileSync(path.join(real, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const keep = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === lastTag) + 1);
  const dir = mkdtempSync(path.join(tmpdir(), 'scout-routing-'));
  mkdirSync(path.join(dir, 'meta'));
  for (const e of keep) copyFileSync(path.join(real, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  writeFileSync(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: keep }));
  return dir;
}

describe('routing 0006: stages for existing workspaces', () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let sql: postgres.Sql;
  beforeAll(async () => {
    db = await freshDatabase(`scout_test_${process.pid}_routing_stages`);
    await migrateAll({ adminUrl: db.adminUrl, folders: { routing: routingUpTo('0005_review_settings_version') } });
    sql = postgres(db.adminUrl, { max: 1, onnotice: () => {} });
    await sql`insert into routing.review_status_def (id, tenant_id, key, label, "order") values ('rsd_1', 't_old', 'unvetted', 'Ready for review', 1)`;
    for (const [id, from, to] of [['stc_1', 'arrived', 'reviewed'], ['stc_2', 'engaged', 'declined'], ['stc_3', 'opportunity', 'lost'], ['stc_4', 'reviewed', 'stg_custom']] as const) {
      await sql`insert into routing.stage_change (id, tenant_id, account_id, from_stage, to_stage, cause_event_id) values (${id}, 't_old', 'acc_1', ${from}, ${to}, ${id})`;
    }
    await migrateAll({ adminUrl: db.adminUrl });
  });
  afterAll(async () => {
    await sql?.end();
    await db.drop();
  });

  it('gives an existing workspace the default stages under its keys', async () => {
    const rows = await sql`select key, name, kind, "position", trigger, hubspot_stage, locked from routing.pipeline_stage where tenant_id = 't_old' order by kind, "position"`;
    expect(rows.map((r) => [r.key, r.name, r.kind, r.trigger, r.hubspot_stage, r.locked])).toEqual(
      DEFAULT_STAGES.slice().sort((x, y) => x.kind.localeCompare(y.kind) || x.position - y.position).map((s) => [s.key, s.name, s.kind, s.trigger, s.hubspotStage, s.locked]),
    );
  });

  it('backfills history names from the labels it had', async () => {
    const rows = await sql`select from_name, to_name from routing.stage_change where tenant_id = 't_old' order by id`;
    expect(rows.map((r) => [r.from_name, r.to_name])).toEqual([
      ['Arrived', 'Reviewed'],
      ['Engaged', 'Not pursued'],
      ['Opportunity', 'Lost'],
      ['Reviewed', 'stg_custom'],
    ]);
  });
});
