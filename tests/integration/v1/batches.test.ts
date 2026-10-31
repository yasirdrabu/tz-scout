import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as listBatchesRoute, POST as postBatch } from '@/http/routes/v1/batches/route';
import { GET as getBatchRoute } from '@/http/routes/v1/batches/[id]/route';
import { GET as getArrivalRoute } from '@/http/routes/v1/arrivals/[id]/route';
import { GET as itemsRoute } from '@/http/routes/v1/batches/[id]/items/route';
import { POST as filesRoute } from '@/http/routes/v1/batches/[id]/files/route';
import { closeDbs } from '@/platform/db/client';
import { validArrival } from '../intake/helpers';
import { runOutbox } from '../helpers/run-outbox';
import { call, freshTenant, keyFor, personAndAgent, SEND, uploadForm, type Tenant } from './intake-helpers';

let t: Tenant;
let ashKey: string;
let ashAgent: string;
let boKey: string;

beforeAll(async () => {
  t = await freshTenant();
  const ash = await personAndAgent(t, 'Ash');
  ashAgent = ash.agentId;
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

describe('TEN-E3-S3-AC1: contact details without people:read', () => {
  it('hides people contacts and the introducer email in a rejected item, its detail, the items and the batch', async () => {
    const bad = {
      account: { name: 'Leaky', domain: 'leaky.example.com', external_ref: 'leak-1' },
      people: [{ name: 'Pat', title: 'CTO', email: 'pat@leaky.example', phone: '555-0100', mobile: '555-0199', linkedin_url: 'https://linkedin.com/in/pat-leaky' }],
      warm_intro: { introducer_name: 'Ira', introducer_email: 'ira@intro.example', relationship: 'other' },
    };
    const { batch_id, items } = await (await send(ashKey, [bad], 'Leaky')).json();
    expect(items[0].status).toBe('rejected');
    const arrivalId = items[0].arrival_id;
    const reader = await keyFor(t, ['arrivals:read'], { sourceId: ashAgent });
    const full = await keyFor(t, ['arrivals:read', 'people:read'], { sourceId: ashAgent });

    const texts = [
      await (await call(getArrivalRoute, reader, `arrivals/${arrivalId}`)).text(),
      await (await call(itemsRoute, reader, `batches/${batch_id}/items`)).text(),
      await (await call(getBatchRoute, reader, `batches/${batch_id}`)).text(),
    ];
    for (const text of texts) {
      for (const secret of ['pat@leaky.example', '555-0100', '555-0199', 'pat-leaky', 'ira@intro.example']) expect(text).not.toContain(secret);
    }
    expect(texts[0]).toContain('CTO');
    expect(await (await call(getArrivalRoute, full, `arrivals/${arrivalId}`)).text()).toContain('pat@leaky.example');
  });
});

describe('GET /v1/batches/{id} files', () => {
  it('lists the attached files', async () => {
    const { batch_id } = await (await send(ashKey, [validArrival()], 'Files')).json();
    await call(filesRoute, ashKey, `batches/${batch_id}/files`, { body: uploadForm('one.csv', 'a,b\n1,2\n') });
    const b = await (await call(getBatchRoute, ashKey, `batches/${batch_id}`)).json();
    expect(b.files).toHaveLength(1);
    expect(b.files[0]).toMatchObject({ file_name: 'one.csv', content_type: expect.stringContaining('text/csv'), size_bytes: 8, sha256: expect.any(String), created_at: expect.any(String) });
    expect(b.files[0].created_at).toMatch(/^[0-9]{4}-/);
    expect(b.files[0]).not.toHaveProperty('storage_key');
  });
});

describe('TEN-E3-S3-AC1: off-contract contact keys', () => {
  it('keeps only allowed keys on people and warm_intro in a rejected item', async () => {
    const bad = {
      account: { name: 'Odd', domain: 'odd.example.com', external_ref: 'odd-1' },
      people: [{ name: 'Quinn', title: 'VP', work_email: 'quinn@odd.example', phone_number: '555-0142', Email: 'Q@odd.example', home: 'Elm St 9' }],
      warm_intro: { introducer_name: 'Ira', contact: 'ira-direct@odd.example', relationship: 'other' },
    };
    const { items } = await (await send(ashKey, [bad], 'Odd')).json();
    expect(items[0].status).toBe('rejected');
    const reader = await keyFor(t, ['arrivals:read'], { sourceId: ashAgent });
    const text = await (await call(getArrivalRoute, reader, `arrivals/${items[0].arrival_id}`)).text();
    for (const secret of ['quinn@odd.example', '555-0142', 'Q@odd.example', 'Elm St 9', 'ira-direct@odd.example']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('Quinn');
    expect(text).toContain('Ira');
  });
});
