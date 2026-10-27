import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  confirmImport,
  createImport,
  getBatch,
  getImport,
  importRunHandler,
  listWaiting,
  registerSource,
  skipWaiting,
  updateSource,
} from '@/modules/intake';
import { arrival, batch } from '@/modules/intake/db/schema';
import { closeDbs } from '@/platform/db/client';
import { EnvelopeSchema } from '@/platform/events/envelope';
import { newId } from '@/platform/ids';
import { deliverOnce } from '@/platform/runtime/worker';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let personId: string;
let agentId: string;

afterAll(closeDbs);

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  ({ personId, agentId } = await personAndAgent(t));
});

const csv = (text: string, fileName = 'list.csv') => ({ fileName, contentType: 'text/csv', bytes: Buffer.from(text) });
const col = (header: string, target: string | null) => ({ header, target, confidence: 1, reason: 'Chosen by a person.' });
const asPerson = <T>(fn: Parameters<typeof asSource<T>>[2]) => asSource(t, personId, fn);
const fixture = (name: string) => readFileSync(join(__dirname, '../../fixtures/imports', name));
let n = 0;
const stamp = () => `${Date.now().toString(36)}${++n}`;
const batchCount = () => t.run(async (ctx) => (await ctx.tx.select({ id: batch.id }).from(batch)).length);
type Run = <T>(fn: Parameters<typeof asSource<T>>[2]) => Promise<T>;

/**
 * An import that needs its mapping. Headers carry a fresh suffix so an earlier confirm's saved mapping
 * (kept per source and header set) does not apply. `map` is the mapping a person would confirm.
 */
async function needingConfirm(rows: string[], opts: { as?: Run; withNotes?: boolean; vendorSourceId?: string } = {}) {
  const k = stamp();
  const headers = [`Company ${k}`, `Website ${k}`, ...(opts.withNotes ? [`Notes ${k}`] : [])];
  const as = opts.as ?? asPerson;
  const text = `${[headers.join(','), ...rows].join('\n')}\n`;
  const r = await as((ctx) => createImport(ctx, { ...csv(text), vendorSourceId: opts.vendorSourceId }));
  if (r.status !== 'needs_confirm') throw new Error(`expected needs_confirm, got ${r.status}`);
  const targets = ['account.name', 'account.website', 'account.notes'];
  return { r, map: headers.map((h, i) => col(h, targets[i]!)) };
}

const runJob = (importId: string) =>
  deliverOnce(
    importRunHandler,
    EnvelopeSchema.parse({
      id: newId('evt'),
      type: 'jobs.intake.import.run',
      schemaVersion: 1,
      tenantId: t.tenantId,
      occurredAt: new Date().toISOString(),
      actor: { kind: 'system', id: 'worker' },
      correlationId: newId('cor'),
      data: { importId },
    }),
  );

describe('dropping files', () => {
  it('SRC-E4-S1-AC1: three imports give three batches, each with its sha256', async () => {
    const files = [1, 2, 3].map((i) => csv(`Company,Website\nDrop ${i},drop-${stamp()}.com\n`, `drop-${i}.csv`));
    const made = [];
    for (const f of files) made.push(await asPerson((ctx) => createImport(ctx, f)));
    for (const [i, m] of made.entries()) {
      if (m.status === 'needs_sheet') throw new Error('unexpected sheet prompt');
      expect(m.sha256).toBe(createHash('sha256').update(files[i]!.bytes).digest('hex'));
    }
    const ids = made.map((m) => (m.status === 'needs_sheet' ? '' : m.batchId));
    expect(new Set(ids).size).toBe(3);
    const first = made[0]!;
    if (first.status === 'needs_sheet') throw new Error('unexpected sheet prompt');
    const detail = await asPerson((ctx) => getImport(ctx, first.id));
    expect(detail?.file.sha256).toBe(createHash('sha256').update(files[0]!.bytes).digest('hex'));
  });

  it('SRC-E4-S1-AC3: a multi-sheet file needs a sheet, and stores nothing', async () => {
    const wb = new ExcelJS.Workbook();
    for (const name of ['First', 'Second']) {
      const ws = wb.addWorksheet(name);
      ws.addRow(['Company', 'Website']);
      ws.addRow([`${name} Co`, `${name.toLowerCase()}-${stamp()}.com`]);
    }
    const file = { fileName: 'two.xlsx', contentType: 'application/octet-stream', bytes: Buffer.from(await wb.xlsx.writeBuffer()) };
    const before = await batchCount();
    expect(await asPerson((ctx) => createImport(ctx, file))).toEqual({ status: 'needs_sheet', sheets: ['First', 'Second'] });
    expect(await batchCount()).toBe(before);
    expect((await asPerson((ctx) => createImport(ctx, { ...file, sheet: 'Second' }))).status).toBe('needs_confirm');
  });

  it('refuses an unreadable file as a 400 and stores nothing', async () => {
    const before = await batchCount();
    await expect(asPerson((ctx) => createImport(ctx, csv('Company,Website\n')))).rejects.toMatchObject({
      status: 400,
      message: "Didn't find a header row and at least one row of data.",
    });
    expect(await batchCount()).toBe(before);
  });

  it('needs a source (403), and a vendor must be a vendor source (400)', async () => {
    await expect(t.run((ctx) => createImport(ctx, csv('Company,Website\nA,a.com\n')))).rejects.toMatchObject({ status: 403 });
    await expect(
      asPerson((ctx) => createImport(ctx, { ...csv('Company,Website\nA,a.com\n'), vendorSourceId: agentId })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('running an import', () => {
  it('SRC-E4-S4-AC1: a research file imports with no confirm and getImport shows the counts', async () => {
    const r = await asPerson((ctx) =>
      createImport(ctx, { fileName: 'research.csv', contentType: 'text/csv', bytes: fixture('research-master.csv') }),
    );
    if (r.status === 'needs_sheet') throw new Error('unexpected sheet prompt');
    expect(r.status).toBe('queued');
    expect(r.layout).toBeTruthy();
    await runOutbox(t.tenantId);
    const d = await asPerson((ctx) => getImport(ctx, r.id));
    expect(d).toMatchObject({
      status: 'imported',
      stats: { companies: 2, created: 2, attached: 0, rejected: 0, waiting: { count: 0, arrivalIds: [] }, skipped: [] },
    });
    expect(await asPerson((ctx) => getBatch(ctx, r.batchId))).toMatchObject({ status: 'completed', itemCount: 2 });
  });

  it('SRC-E4-S4-AC2: skipWaiting completes the batch', async () => {
    const { r, map } = await needingConfirm([`Has Site,has-${stamp()}.com,x`, 'No Site,,y', ',,orphan'], { withNotes: true });
    await asPerson((ctx) => confirmImport(ctx, r.id, map));
    await runOutbox(t.tenantId);
    const d = (await asPerson((ctx) => getImport(ctx, r.id)))!;
    expect(d.stats).toMatchObject({ companies: 2, created: 1, waiting: { count: 1 } });
    expect(d.stats.skipped).toHaveLength(1);
    expect(d.stats.waiting.arrivalIds).toHaveLength(1);
    expect((await asPerson((ctx) => getBatch(ctx, r.batchId)))?.status).toBe('processing');
    expect((await asPerson((ctx) => listWaiting(ctx))).data.map((a) => a.id)).toContain(d.stats.waiting.arrivalIds[0]);

    expect(await asPerson((ctx) => skipWaiting(ctx, r.batchId, 'Ash'))).toBe(1);
    await runOutbox(t.tenantId);
    const after = (await asPerson((ctx) => getImport(ctx, r.id)))!;
    expect(after.stats).toMatchObject({ created: 1, rejected: 1, waiting: { count: 0 } });
    expect((await asPerson((ctx) => getBatch(ctx, r.batchId)))?.status).toBe('completed');
  });

  it('does not submit twice when the job is delivered again', async () => {
    const { r, map } = await needingConfirm([`Once Co,once-${stamp()}.com`]);
    await asPerson((ctx) => confirmImport(ctx, r.id, map));
    await runOutbox(t.tenantId);
    await runJob(r.id);
    await runOutbox(t.tenantId);
    const rows = await t.run((ctx) => ctx.tx.select({ id: arrival.id }).from(arrival).where(eq(arrival.batchId, r.batchId)));
    expect(rows).toHaveLength(1);
  });

  it('stores each arrival with the file channel, the rows as raw and the chosen vendor', async () => {
    const vendor = await t.run((ctx) => registerSource(ctx, { kind: 'vendor', name: 'List shop' }));
    const { r, map } = await needingConfirm([`Vend Co,vend-${stamp()}.com`], { vendorSourceId: vendor.id });
    await asPerson((ctx) => confirmImport(ctx, r.id, map));
    await runOutbox(t.tenantId);
    const [row] = await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.batchId, r.batchId)));
    expect(row).toMatchObject({ channel: 'file', closestSourceId: personId, personSourceId: personId, vendorSourceId: vendor.id });
    expect((row!.payload as { raw: { headers: string[] } }).raw.headers).toEqual(map.map((c) => c.header));
    const [b] = await t.run((ctx) => ctx.tx.select().from(batch).where(eq(batch.id, r.batchId)));
    expect(b).toMatchObject({ personSourceId: personId, vendorSourceId: vendor.id });
  });

  it("keeps an agent's cap: companies over it are reported, not stored", async () => {
    await t.run((ctx) => updateSource(ctx, agentId, { dailyArrivalCap: 1 }));
    const as: Run = (fn) => asSource(t, agentId, fn);
    const { r, map } = await needingConfirm([`Cap A,cap-a-${stamp()}.com`, `Cap B,cap-b-${stamp()}.com`], { as });
    await as((ctx) => confirmImport(ctx, r.id, map));
    await runOutbox(t.tenantId);
    const d = (await as((ctx) => getImport(ctx, r.id)))!;
    expect(d.stats.created).toBe(1);
    expect(d.stats.notSent).toHaveLength(1);
  });

  it("hides another source's import", async () => {
    const { r, map } = await needingConfirm([`Hide Co,hide-${stamp()}.com`]);
    const other = await personAndAgent(t, 'Quinn');
    expect(await asSource(t, other.personId, (ctx) => getImport(ctx, r.id))).toBeNull();
    await expect(asSource(t, other.personId, (ctx) => confirmImport(ctx, r.id, map))).rejects.toMatchObject({ status: 404 });
  });
});
