import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as fileRoute } from '@/http/routes/v1/batches/[id]/files/[fileId]/route';
import { GET as itemsRoute } from '@/http/routes/v1/batches/[id]/items/route';
import { GET as rejectionsRoute } from '@/http/routes/v1/batches/[id]/rejections/route';
import { GET as getBatchRoute, POST as batchAction } from '@/http/routes/v1/batches/[id]/route';
import { GET as listRoute, POST as postBatch } from '@/http/routes/v1/batches/route';
import { DELETE as deleteImport, GET as getImportRoute, POST as importAction } from '@/http/routes/v1/imports/[id]/route';
import { POST as postImport } from '@/http/routes/v1/imports/route';
import { POST as postSource } from '@/http/routes/v1/sources/route';
import { PATCH as patchSource } from '@/http/routes/v1/sources/[id]/route';
import { personSourceFor } from '@/modules/intake';
import { arrival, columnMapping, fileBlob, fileImport, source } from '@/modules/intake/db/schema';
import { closeDbs } from '@/platform/db/client';
import { auditLog } from '@/platform/db/schema';
import { validArrival } from '../intake/helpers';
import { call, keyFor, SEND, uploadForm } from './intake-helpers';
import { workspace, type Workspace } from './review-helpers';


let w: Workspace;
let other: Workspace;
let operator: string;
let seller: string;
let personSource: string;
let list: { id: string; name: string };
let agentKey: string;

const json = async (p: Promise<Response>, status = 200) => {
  const res = await p;
  const body = res.status === 204 ? null : await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return body;
};

let n = 0;
const uid = () => `${Date.now().toString(36)}${++n}`;
/** A CSV with unique domains: two of the four companies have no website. The badge header keeps the headers unique, so no saved mapping applies. */
const fourRows = (k: string, badge = k) =>
  `Company,Website,Notes,Badge ${badge}\nAlpha ${k},alpha-${k}.example,Met at the fair,B1\nBeta ${k},,Asked for a call,B2\nGamma ${k},gamma-${k}.example,,B3\nDelta ${k},,,B4\n`;

const importAs = (userId: string, name: string, csv: string, fields: Record<string, string> = {}) =>
  w.as(userId, postImport, 'imports', 'POST', uploadForm(name, csv, fields));

const confirmAll = async (importId: string) => {
  const got = await json(w.as(operator, getImportRoute, `imports/${importId}`));
  return json(w.as(operator, importAction, `imports/${importId}:confirm`, 'POST', { mapping: got.mapping }), 202);
};

beforeAll(async () => {
  w = await workspace('Batch Co');
  other = await workspace('Other Batch Co');
  operator = await w.person('operator', { name: 'Riley Op' });
  seller = await w.person('seller', { name: 'Sam Seller' });
  // The operator's person source is made the first time they act.
  await w.as(operator, listRoute, 'batches');
  personSource = (await w.run((ctx) => personSourceFor(ctx, operator)))!;
  list = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'list', name: 'Fair list', parent_id: personSource }), 201);
  agentKey = await keyFor(w.tenant, SEND, { sourceId: w.source.agentId });
});
afterAll(closeDbs);

describe('POST /api/v1/imports with source_id, notes and name (Ruling 10)', () => {
  it('credits the list: its chain, its mapping, and the column-match read', async () => {
    const k = uid();
    const created = await json(importAs(operator, `fair-${k}.csv`, fourRows(k), { source_id: list.id, notes: 'Fair notes', name: 'Fair batch' }), 202);
    expect(created).toMatchObject({
      status: 'needs_confirm',
      source: { id: list.id, name: 'Fair list', kind: 'list' },
      uploaded_by: { user_id: operator, name: 'Riley Op' },
      notes: 'Fair notes',
      file: { name: `fair-${k}.csv`, type: 'CSV', size_bytes: fourRows(k).length, sheet: null },
      mapping_origin: 'synonyms',
      suggested_count: 3,
    });
    expect(created.sample_rows[0]).toEqual([`Alpha ${k}`, `alpha-${k}.example`, 'Met at the fair', 'B1']);
    expect(created.sample_rows).toHaveLength(4);
    const labels = created.targets.map((t: { label: string }) => t.label);
    expect(labels.slice(0, 9)).toEqual(['Company name', 'Website', 'Location', 'Person name', 'Job title', 'Email', 'Phone', 'Notes', "Don't import"]);
    expect(created.targets[8]).toEqual({ key: null, label: "Don't import" });
    expect(created.targets.find((t: { key: string }) => t.key === 'account.domain').label).toBe('Domain');

    const preview = await json(w.as(operator, importAction, `imports/${created.import_id}:preview`, 'POST'));
    expect(preview).toMatchObject({ total: 4, without_website: 2, go_ahead: 2 });

    await confirmAll(created.import_id);
    await w.deliver();
    const [b] = await w.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.batchId, created.batch_id)).limit(1));
    expect(b).toMatchObject({ agentSourceId: list.id, personSourceId: personSource, closestSourceId: list.id });

    const batch = await json(w.as(operator, getBatchRoute, `batches/${created.batch_id}`));
    expect(batch).toMatchObject({ name: 'Fair batch', notes: 'Fair notes', source: { id: list.id, name: 'Fair list', kind: 'list' }, sent_by: { kind: 'user', id: operator, name: 'Riley Op' } });

    // The mapping was saved under the list, so the same headers go straight to the run.
    const saved = await w.run((ctx) => ctx.tx.select().from(columnMapping).where(eq(columnMapping.sourceId, list.id)));
    expect(saved).toHaveLength(1);
    const k2 = uid();
    const again = await json(importAs(operator, 'again.csv', fourRows(k2, k), { source_id: list.id }), 202);
    expect(again).toMatchObject({ status: 'queued', mapping_origin: 'saved', notes: null });
    expect((await json(w.as(operator, getBatchRoute, `batches/${again.batch_id}`))).name).toBe('again.csv');
  });

  it('refuses source_id from a caller who does not manage sources, and a source that cannot be credited', async () => {
    const key = await keyFor(w.tenant, ['imports:run', 'arrivals:read'], { sourceId: w.source.agentId });
    const res = await call(postImport, key, 'imports', { body: uploadForm('x.csv', fourRows(uid()), { source_id: list.id }) });
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.detail).toBe('Only people who manage sources can credit another source.');

    const vendor = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'vendor', name: `Vendor ${uid()}` }), 201);
    const bad = await json(importAs(operator, 'x.csv', fourRows(uid()), { source_id: vendor.id }), 400);
    expect(bad.errors[0].path).toBe('source_id');
    await json(importAs(operator, 'x.csv', fourRows(uid()), { source_id: other.source.personId }), 404);
    expect((await json(importAs(operator, 'x.csv', fourRows(uid()), { notes: 'x'.repeat(1001) }), 400)).errors[0].path).toBe('notes');
  });

  it('refuses a paused credited source as today', async () => {
    const paused = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'list', name: `Paused ${uid()}`, parent_id: personSource }), 201);
    await json(w.as(operator, patchSource, `sources/${paused.id}`, 'PATCH', { status: 'paused' }));
    const res = await json(importAs(operator, 'x.csv', fourRows(uid()), { source_id: paused.id }), 403);
    expect(res.title).toBe('This source is paused');
  });
});

describe('DELETE /api/v1/imports/{id} (Ruling 11)', () => {
  it('discards an import that waits for confirming, again and again, and leaves its batch out of the list', async () => {
    const created = await json(importAs(operator, 'discard.csv', fourRows(uid()), { source_id: list.id }), 202);
    await json(w.as(operator, deleteImport, `imports/${created.import_id}`, 'DELETE'), 204);
    await json(w.as(operator, deleteImport, `imports/${created.import_id}`, 'DELETE'), 204);
    const [imp] = await w.run((ctx) => ctx.tx.select().from(fileImport).where(eq(fileImport.id, created.import_id)));
    expect(imp!.status).toBe('cancelled');
    expect(await w.run((ctx) => ctx.tx.select().from(fileBlob).where(eq(fileBlob.storageKey, imp!.storageKey)))).toHaveLength(0);
    const listed = await json(w.as(operator, listRoute, 'batches?limit=200'));
    expect(listed.data.map((b: { id: string }) => b.id)).not.toContain(created.batch_id);
    await json(w.as(operator, getImportRoute, `imports/${created.import_id}`), 404);
    const audits = await w.run((ctx) => ctx.tx.select().from(auditLog).where(and(eq(auditLog.action, 'intake.import.discarded'), eq(auditLog.subjectId, created.import_id))));
    expect(audits).toHaveLength(1);
  });

  it('refuses an import that has started, a key, and another tenant', async () => {
    const created = await json(importAs(operator, 'started.csv', fourRows(uid()), { source_id: list.id }), 202);
    await confirmAll(created.import_id);
    const res = await json(w.as(operator, deleteImport, `imports/${created.import_id}`, 'DELETE'), 409);
    expect(res.title).toBe("This import has started, so it can't be discarded.");
    const key = await keyFor(w.tenant, ['imports:run', 'arrivals:read'], { sourceId: w.source.agentId });
    expect((await call(deleteImport, key, `imports/${created.import_id}`, { method: 'DELETE' })).status).toBe(403);
    const stranger = await other.person('operator');
    await json(other.as(stranger, deleteImport, `imports/${created.import_id}`, 'DELETE'), 404);
  });
});

describe('GET /api/v1/batches: filters, derived status, total and meta', () => {
  let apiBatch: string;
  let fileBatch: string;

  beforeAll(async () => {
    const k = uid();
    const sent = await json(call(postBatch, agentKey, 'batches', { body: { name: `Alpha ${k}`, notes: `Notes ${k}`, items: [validArrival()] } }), 202);
    apiBatch = sent.batch_id;
    const imported = await json(importAs(operator, `beta-${k}.csv`, fourRows(k), { source_id: list.id }), 202);
    fileBatch = imported.batch_id;
    await confirmAll(imported.import_id);
    await w.deliver();
  });

  const ids = (body: { data: { id: string }[] }) => body.data.map((b) => b.id);

  it('shows the derived status, issue, stages, source, sender and files on each row', async () => {
    const body = await json(w.as(operator, listRoute, 'batches?limit=200'));
    const row = body.data.find((b: { id: string }) => b.id === fileBatch);
    expect(row).toMatchObject({
      status_key: 'needs_attention',
      status_label: 'Needs attention',
      issue: '2 rows need a website, a company or a duplicate check',
      stages: { waiting: 2, resolved: 2, rejected: 0 },
      progress_label: '2 resolved, 0 rejected, 2 waiting',
      source: { id: list.id, kind: 'list' },
      sent_by: { kind: 'user', id: operator, name: 'Riley Op' },
      import: { status: 'imported', error: null },
      retryable: 0,
    });
    expect(row.files[0]).toMatchObject({ id: expect.stringMatching(/^fil_/), file_name: expect.stringMatching(/^beta-/), content_type: expect.stringContaining('text/csv') });
    const api = body.data.find((b: { id: string }) => b.id === apiBatch);
    expect(api).toMatchObject({ status_key: 'complete', issue: null, sent_by: { kind: 'api_key', name: 'k' }, source: { id: w.source.agentId }, import: null });
    expect(body.total).toBe(body.data.length);
    expect(body.meta.counts_by_status.needs_attention).toBeGreaterThanOrEqual(1);
    expect(body.meta.status_labels).toEqual({ complete: 'Complete', in_progress: 'In progress', needs_attention: 'Needs attention', failed: 'Failed' });
    expect(body.meta.attention.count).toBe(body.meta.counts_by_status.needs_attention + body.meta.counts_by_status.failed);
    expect(body.meta.attention.issues).toContain('2 rows need a website, a company or a duplicate check');
  });

  it('narrows by search, source, sender, date and status, and the total follows', async () => {
    const byName = await json(w.as(operator, listRoute, `batches?q=${encodeURIComponent('alpha ')}`));
    expect(ids(byName)).toContain(apiBatch);
    expect(ids(byName)).not.toContain(fileBatch);
    const byNotes = await json(w.as(operator, listRoute, `batches?q=notes`));
    expect(ids(byNotes)).toContain(apiBatch);
    const byFile = await json(w.as(operator, listRoute, 'batches?q=beta-'));
    expect(ids(byFile)).toEqual([fileBatch]);
    expect(byFile.total).toBe(1);
    expect(ids(await json(w.as(operator, listRoute, `batches?source_id=${list.id}`)))).toContain(fileBatch);
    expect(ids(await json(w.as(operator, listRoute, `batches?source_id=${list.id}`)))).not.toContain(apiBatch);
    const mine = await json(w.as(operator, listRoute, `batches?sent_by=${operator}`));
    expect(ids(mine)).toContain(fileBatch);
    expect(ids(mine)).not.toContain(apiBatch);
    expect((await json(w.as(operator, listRoute, 'batches?since=2999-01-01'))).total).toBe(0);
    const attention = await json(w.as(operator, listRoute, 'batches?status_key=needs_attention&status_key=failed'));
    expect(ids(attention)).toContain(fileBatch);
    expect(ids(attention)).not.toContain(apiBatch);
    expect(attention.total).toBe(attention.data.length);
    // Every filter but the status shapes the status counts.
    expect(attention.meta.counts_by_status.complete).toBeGreaterThanOrEqual(1);
  });

  it('refuses a bad filter with 400, a seller with 403, and never lists another tenant', async () => {
    expect((await json(w.as(operator, listRoute, 'batches?status_key=late'), 400)).errors[0].path).toBe('status_key');
    expect((await json(w.as(operator, listRoute, 'batches?since=soon'), 400)).errors[0].path).toBe('since');
    await json(w.as(seller, listRoute, 'batches'), 403);
    const stranger = await other.person('operator');
    expect(ids(await json(other.as(stranger, listRoute, 'batches?limit=200')))).not.toContain(fileBatch);
  });

  it('opens one batch with the same row, its counts and how many are in the review queue', async () => {
    const body = await json(w.as(operator, getBatchRoute, `batches/${fileBatch}`));
    expect(body).toMatchObject({ id: fileBatch, status_key: 'needs_attention', stages: { waiting: 2 }, in_queue: 2, rejections: [] });
    const key = await keyFor(w.tenant, ['arrivals:read'], { sourceId: list.id });
    expect((await json(call(getBatchRoute, key, `batches/${fileBatch}`))).in_queue).toBeNull();
    const stranger = await other.person('operator');
    await json(other.as(stranger, getBatchRoute, `batches/${fileBatch}`), 404);
  });

  it('lists items by status with their outcome words and the total', async () => {
    const waiting = await json(w.as(operator, itemsRoute, `batches/${fileBatch}/items?status=waiting`));
    expect(waiting.total).toBe(2);
    expect(waiting.data).toHaveLength(2);
    for (const item of waiting.data) expect(item).toMatchObject({ outcome: 'waiting', outcome_label: 'Waiting: Needs a website', waiting_on: 'needs_website', website: null });
    expect(waiting.data.map((i: { company_name: string }) => i.company_name.split(' ')[0]).sort()).toEqual(['Beta', 'Delta']);
    const resolved = await json(w.as(operator, itemsRoute, `batches/${fileBatch}/items?status=resolved`));
    expect(resolved.total).toBe(2);
    expect(resolved.data[0]).toMatchObject({ outcome: 'new_account', outcome_label: 'Resolved: New account', account_id: expect.stringMatching(/^acc_/), account_name: expect.any(String), tier: expect.any(String), tier_label: expect.any(String), stage: 'arrived' });
    expect(resolved.data[0].website).toMatch(/\.example$/);
    expect((await json(w.as(operator, itemsRoute, `batches/${fileBatch}/items`))).total).toBe(4);
    expect((await json(w.as(operator, itemsRoute, `batches/${fileBatch}/items?status=lost`), 400)).errors[0].path).toBe('status');
    const stranger = await other.person('operator');
    await json(other.as(stranger, itemsRoute, `batches/${fileBatch}/items`), 404);
  });

  it('downloads the original file with its type and a safe name', async () => {
    const body = await json(w.as(operator, getBatchRoute, `batches/${fileBatch}`));
    const file = body.files[0];
    const res = await w.as(operator, fileRoute, `batches/${fileBatch}/files/${file.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${file.file_name}"`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const k = file.file_name.slice('beta-'.length, -'.csv'.length);
    expect(await res.text()).toBe(fourRows(k));
    // Another batch's file id is a 404 under this batch.
    await json(w.as(operator, fileRoute, `batches/${apiBatch}/files/${file.id}`), 404);
    const stranger = await other.person('operator');
    await json(other.as(stranger, fileRoute, `batches/${fileBatch}/files/${file.id}`), 404);
    await json(w.as(seller, fileRoute, `batches/${fileBatch}/files/${file.id}`), 403);
  });

  it('keeps a hostile file name out of the header', async () => {
    const created = await json(importAs(operator, 'evil".csv\r\nx: 1', fourRows(uid()), { source_id: list.id }), 202);
    const b = await json(w.as(operator, getBatchRoute, `batches/${created.batch_id}`));
    const res = await w.as(operator, fileRoute, `batches/${created.batch_id}/files/${b.files[0].id}`);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[^"\r\n]*"; filename\*=UTF-8''/);
  });
});

describe('GET /api/v1/batches/{id}/rejections?format=csv', () => {
  it('gives the rejected rows as CSV, formula cells escaped', async () => {
    const dup = `dup-${uid()}.example`;
    const sent = await json(
      call(postBatch, agentKey, 'batches', {
        body: { name: 'Rejects', items: [{ account: { name: '=HYPERLINK("x")', domain: dup } }, { account: { name: 'Second', domain: dup } }, { account: { name: 'Bad', employees: 'many' } }] },
      }),
      202,
    );
    const res = await w.as(operator, rejectionsRoute, `batches/${sent.batch_id}/rejections?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${sent.batch_id}-rejected.csv"`);
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[0]).toBe('row,company,website,reason,detail,person,email,phone');
    expect(lines.some((l) => l.startsWith(`1,Second,${dup},Duplicate of another row in this batch,`))).toBe(true);
    expect(lines.some((l) => l.startsWith("2,'Bad") || l.startsWith('2,Bad,,Invalid row,'))).toBe(true);
    // Without people:read the contact columns are left out.
    const reader = await keyFor(w.tenant, ['arrivals:read'], { sourceId: w.source.agentId });
    const plain = await (await call(rejectionsRoute, reader, `batches/${sent.batch_id}/rejections?format=csv`)).text();
    expect(plain.split('\r\n')[0]).toBe('row,company,website,reason,detail');
    await json(w.as(operator, rejectionsRoute, `batches/${sent.batch_id}/rejections?format=xml`), 400);
    await json(w.as(seller, rejectionsRoute, `batches/${sent.batch_id}/rejections?format=csv`), 403);
    const stranger = await other.person('operator');
    await json(other.as(stranger, rejectionsRoute, `batches/${sent.batch_id}/rejections?format=csv`), 404);
  });

  it('escapes a cell that starts like a formula', async () => {
    const sent = await json(call(postBatch, agentKey, 'batches', { body: { name: 'Formula', items: [{ account: { name: '=cmd()', employees: 'x' } }] } }), 202);
    const text = await (await w.as(operator, rejectionsRoute, `batches/${sent.batch_id}/rejections?format=csv`)).text();
    expect(text.split('\r\n')[1]).toMatch(/^1,'=cmd\(\),/);
  });
});

describe('POST /api/v1/batches/{id}:retry', () => {
  it('sends the rows the daily limit stopped again, once, and audits it', async () => {
    const capped = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'partner', name: `Capped ${uid()}`, daily_arrival_cap: 1 }), 201);
    const key = await keyFor(w.tenant, SEND, { sourceId: capped.id });
    const sent = await json(call(postBatch, key, 'batches', { body: { name: 'Capped', items: [validArrival(), validArrival(), validArrival()] } }), 202);
    await w.deliver();
    const before = await json(w.as(operator, getBatchRoute, `batches/${sent.batch_id}`));
    expect(before).toMatchObject({ retryable: 2, status_key: 'needs_attention', issue: '2 rows hit the daily limit' });

    await w.run((ctx) => ctx.tx.update(source).set({ dailyArrivalCap: 10 }).where(eq(source.id, capped.id)));
    expect(await json(w.as(operator, batchAction, `batches/${sent.batch_id}:retry`, 'POST'), 202)).toEqual({ retried: 2 });
    const res = await json(w.as(operator, batchAction, `batches/${sent.batch_id}:retry`, 'POST'), 409);
    expect(res.title).toBe('Nothing in this batch can be retried.');
    await w.deliver();
    const after = await json(w.as(operator, getBatchRoute, `batches/${sent.batch_id}`));
    expect(after).toMatchObject({ retryable: 0, status_key: 'complete', item_count: 3, stages: { resolved: 3, rejected: 0 } });
    const audits = await w.run((ctx) => ctx.tx.select().from(auditLog).where(and(eq(auditLog.action, 'intake.batch.retried'), eq(auditLog.subjectId, sent.batch_id))));
    expect(audits).toHaveLength(1);
  });

  it('refuses a key, a seller and another tenant', async () => {
    const sent = await json(call(postBatch, agentKey, 'batches', { body: { name: 'Nope', items: [validArrival()] } }), 202);
    const key = await keyFor(w.tenant, ['imports:run', 'arrivals:read'], { sourceId: w.source.agentId });
    expect((await call(batchAction, key, `batches/${sent.batch_id}:retry`, { method: 'POST' })).status).toBe(403);
    await json(w.as(seller, batchAction, `batches/${sent.batch_id}:retry`, 'POST'), 403);
    const stranger = await other.person('operator');
    await json(other.as(stranger, batchAction, `batches/${sent.batch_id}:retry`, 'POST'), 404);
  });

  it('picks up an import that stopped because its source was paused', async () => {
    const lst = await json(w.as(operator, postSource, 'sources', 'POST', { kind: 'list', name: `Stops ${uid()}`, parent_id: personSource }), 201);
    const k = uid();
    const csv = `Company,Website\nOne ${k},one-${k}.example\nTwo ${k},two-${k}.example\n`;
    const first = await json(importAs(operator, 'stops.csv', csv, { source_id: lst.id }), 202);
    await confirmAll(first.import_id);
    await json(w.as(operator, patchSource, `sources/${lst.id}`, 'PATCH', { status: 'paused' }));
    await w.deliver();
    const stopped = await json(w.as(operator, getBatchRoute, `batches/${first.batch_id}`));
    expect(stopped).toMatchObject({ status_key: 'failed', status_label: 'Failed', issue: 'Import stopped: This source is paused', retryable: 2 });
    await json(w.as(operator, patchSource, `sources/${lst.id}`, 'PATCH', { status: 'active' }));
    expect(await json(w.as(operator, batchAction, `batches/${first.batch_id}:retry`, 'POST'), 202)).toEqual({ retried: 2 });
    await w.deliver();
    expect(await json(w.as(operator, getBatchRoute, `batches/${first.batch_id}`))).toMatchObject({ status_key: 'complete', stages: { resolved: 2 }, import: { status: 'imported' } });
  });
});
