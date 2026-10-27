import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as listBatchesRoute, POST as postBatch } from '@/app/v1/batches/route';
import { GET as getBatchRoute } from '@/app/v1/batches/[id]/route';
import { GET as itemsRoute } from '@/app/v1/batches/[id]/items/route';
import { POST as filesRoute } from '@/app/v1/batches/[id]/files/route';
import { closeDbs } from '@/platform/db/client';
import { validArrival } from '../intake/helpers';
import { runOutbox } from '../helpers/run-outbox';
import { call, freshTenant, keyFor, personAndAgent, SEND, uploadForm, type Tenant } from './intake-helpers';

let t: Tenant;
let ashKey: string;
let boKey: string;

beforeAll(async () => {
  t = await freshTenant();
  const ash = await personAndAgent(t, 'Ash');
  const bo = await personAndAgent(t, 'Bo');
  ashKey = await keyFor(t, SEND, { sourceId: ash.agentId });
  boKey = await keyFor(t, SEND, { sourceId: bo.agentId });
});
afterAll(closeDbs);

const send = (key: string, items: unknown[], name = 'Weekly', headers: Record<string, string> = {}) =>
  call(postBatch, key, 'batches', { body: { name, items }, headers });

describe('POST /v1/batches', () => {
  it('SRC-E2-S2-AC1: answers 202 and returns the arrival ids in the order sent', async () => {
    const items = [validArrival({ external_ref: 'b-1' }), validArrival({ external_ref: 'b-2' }), validArrival({ external_ref: 'b-3' })];
    const res = await send(ashKey, items);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.batch_id).toMatch(/^bat_/);
    expect(body.status_url).toMatch(new RegExp(`/v1/batches/${body.batch_id}$`));
    expect(body.item_count).toBe(3);
    expect(body.items.map((i: { external_ref: string }) => i.external_ref)).toEqual(['b-1', 'b-2', 'b-3']);
    expect(body.items[0]).toMatchObject({ arrival_id: expect.stringMatching(/^arr_/), status: 'received' });
  });

  it('is idempotent on the Idempotency-Key', async () => {
    const items = [validArrival()];
    const a = await (await send(ashKey, items, 'Once', { 'idempotency-key': 'batch-k' })).json();
    const again = await send(ashKey, items, 'Once', { 'idempotency-key': 'batch-k' });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await again.json()).batch_id).toBe(a.batch_id);
  });

  it('refuses a batch without a name or with no items as a 400', async () => {
    expect((await call(postBatch, ashKey, 'batches', { body: { items: [validArrival()] } })).status).toBe(400);
    expect((await send(ashKey, [])).status).toBe(400);
    expect((await call(postBatch, ashKey, 'batches', { body: { name: 'x', items: [validArrival()], extra: 1 } })).status).toBe(400);
  });
});

describe('batch status', () => {
  it('SRC-E2-S3-AC1: shows counts, stages, rejections and the items', async () => {
    const items = [
      validArrival({ external_ref: 'c-1' }),
      { account: { domain: 'acme.com', external_ref: 'c-2' }, unknown_field: true },
    ];
    const { batch_id } = await (await send(ashKey, items, 'Counts')).json();
    await runOutbox(t.tenantId);

    const b = await (await call(getBatchRoute, ashKey, `batches/${batch_id}`)).json();
    expect(b).toMatchObject({ id: batch_id, name: 'Counts', item_count: 2, counts: { resolved: 1, rejected: 1 } });
    expect(b.stages).toMatchObject({ resolved: 1, rejected: 1 });
    expect(b.rejections[0]).toMatchObject({ external_ref: 'c-2', reason: 'invalid' });

    const first = await (await call(itemsRoute, ashKey, `batches/${batch_id}/items?limit=1`)).json();
    expect(first.data).toHaveLength(1);
    const rest = await (await call(itemsRoute, ashKey, `batches/${batch_id}/items?limit=1&cursor=${first.next_cursor}`)).json();
    expect(rest.data).toHaveLength(1);
    expect(rest.next_cursor).toBeNull();

    const listed = await (await call(listBatchesRoute, ashKey, 'batches')).json();
    expect(listed.data.map((x: { id: string }) => x.id)).toContain(batch_id);
    expect(listed).toHaveProperty('next_cursor');
  });

  it('SRC-E2-S2-AC2: a file upload returns its sha256', async () => {
    const { batch_id } = await (await send(ashKey, [validArrival()], 'With file')).json();
    const text = 'name,site\nAcme,acme.com\n';
    const res = await call(filesRoute, ashKey, `batches/${batch_id}/files`, { body: uploadForm('list.csv', text) });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      file_name: 'list.csv',
      size_bytes: text.length,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    expect((await call(filesRoute, ashKey, `batches/${batch_id}/files`, { body: uploadForm('x.csv', 'a', { other: '1' }) })).status).toBe(400);
    const noFile = new FormData();
    noFile.set('note', 'hi');
    expect((await call(filesRoute, ashKey, `batches/${batch_id}/files`, { body: noFile })).status).toBe(400);
  });

  it('SRC-E2-S3-AC3: another source gets 404 for the batch, its items and its files', async () => {
    const { batch_id } = await (await send(ashKey, [validArrival()], 'Private')).json();
    expect((await call(getBatchRoute, boKey, `batches/${batch_id}`)).status).toBe(404);
    expect((await call(itemsRoute, boKey, `batches/${batch_id}/items`)).status).toBe(404);
    expect((await call(filesRoute, boKey, `batches/${batch_id}/files`, { body: uploadForm('x.csv', 'a') })).status).toBe(404);
    const theirs = await (await call(listBatchesRoute, boKey, 'batches')).json();
    expect(theirs.data.map((x: { id: string }) => x.id)).not.toContain(batch_id);
  });
});
