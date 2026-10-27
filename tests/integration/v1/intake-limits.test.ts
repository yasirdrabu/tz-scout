import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as listArrivalsRoute, POST as postArrival } from '@/app/v1/arrivals/route';
import { GET as listBatchesRoute, POST as postBatch } from '@/app/v1/batches/route';
import { GET as itemsRoute } from '@/app/v1/batches/[id]/items/route';
import { POST as filesRoute } from '@/app/v1/batches/[id]/files/route';
import { POST as postImport } from '@/app/v1/imports/route';
import { GET as listSourcesRoute } from '@/app/v1/sources/route';
import { closeDbs } from '@/platform/db/client';
import { validArrival } from '../intake/helpers';
import { call, freshTenant, keyFor, personAndAgent, SEND, uploadForm, type Tenant } from './intake-helpers';

let t: Tenant;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };
let ashKey: string;
let boKey: string;

beforeAll(async () => {
  t = await freshTenant();
  ash = await personAndAgent(t, 'Ash');
  bo = await personAndAgent(t, 'Bo');
  ashKey = await keyFor(t, [...SEND, 'imports:run'], { sourceId: ash.agentId });
  boKey = await keyFor(t, SEND, { sourceId: bo.agentId });
});
afterAll(closeDbs);

const TOO_BIG = 'This request is over the size limit.';
const mb = (n: number) => 'x'.repeat(n * 1024 * 1024);

describe('size limits', () => {
  it('JSON bodies over 5 MB are a 413', async () => {
    const res = await call(postArrival, ashKey, 'arrivals', { body: JSON.stringify({ account: { notes: mb(5) } }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(413);
    expect((await res.json()).title).toBe(TOO_BIG);
  });

  it('checks Content-Length before reading the body', async () => {
    const res = await call(postArrival, ashKey, 'arrivals', {
      body: '{}',
      headers: { 'content-type': 'application/json', 'content-length': String(6 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
  });

  it('batches over 10 MB are a 413, and up to 10 MB are read', async () => {
    const big = await call(postBatch, ashKey, 'batches', { body: JSON.stringify({ name: 'Big', items: [{ account: { notes: mb(10) } }] }) });
    expect(big.status).toBe(413);
    const ok = await call(postBatch, ashKey, 'batches', { body: JSON.stringify({ name: 'Six', items: [{ account: { notes: mb(6) } }] }) });
    expect(ok.status).not.toBe(413);
  });

  it('files over 25 MB are a 413 and imports over 20 MB are a 413', async () => {
    const { batch_id } = await (await call(postBatch, ashKey, 'batches', { body: { name: 'F', items: [validArrival()] } })).json();
    const file = await call(filesRoute, ashKey, `batches/${batch_id}/files`, { body: uploadForm('big.bin', mb(26), {}, 'application/octet-stream') });
    expect(file.status).toBe(413);
    expect((await file.json()).title).toBe(TOO_BIG);
    const imp = await call(postImport, ashKey, 'imports', { body: uploadForm('big.csv', mb(21)) });
    expect(imp.status).toBe(413);
    const smaller = await call(filesRoute, ashKey, `batches/${batch_id}/files`, { body: uploadForm('ok.bin', mb(21), {}, 'application/octet-stream') });
    expect(smaller.status).toBe(201);
  });
});

describe('TEN-E3-S1-AC2: every data limit kind on the list endpoints', () => {
  let ashArrival: string;
  let boArrival: string;
  let ashBatch: string;
  let boBatch: string;

  beforeAll(async () => {
    ashArrival = (await (await call(postArrival, ashKey, 'arrivals', { body: validArrival() })).json()).arrival_id;
    boArrival = (await (await call(postArrival, boKey, 'arrivals', { body: validArrival() })).json()).arrival_id;
    ashBatch = (await (await call(postBatch, ashKey, 'batches', { body: { name: 'A', items: [validArrival()] } })).json()).batch_id;
    boBatch = (await (await call(postBatch, boKey, 'batches', { body: { name: 'B', items: [validArrival()] } })).json()).batch_id;
  });

  const ids = async (res: Response) => (await res.json()).data.map((r: { id: string }) => r.id) as string[];

  const kinds: { name: string; limit: () => unknown; source: () => string | undefined; sees: () => { ash: boolean; bo: boolean } }[] = [
    { name: 'all', limit: () => ({ kind: 'all' }), source: () => undefined, sees: () => ({ ash: true, bo: true }) },
    { name: 'own_source', limit: () => ({ kind: 'own_source' }), source: () => ash.agentId, sees: () => ({ ash: true, bo: false }) },
    { name: 'sources', limit: () => ({ kind: 'sources', ids: [bo.agentId] }), source: () => undefined, sees: () => ({ ash: false, bo: true }) },
    { name: 'practices', limit: () => ({ kind: 'practices', ids: ['prc_none'] }), source: () => undefined, sees: () => ({ ash: false, bo: false }) },
    { name: 'own_accounts', limit: () => ({ kind: 'own_accounts' }), source: () => undefined, sees: () => ({ ash: false, bo: false }) },
    {
      name: 'any_of',
      limit: () => ({ kind: 'any_of', limits: [{ kind: 'own_source' }, { kind: 'sources', ids: [bo.agentId] }] }),
      source: () => ash.agentId,
      sees: () => ({ ash: true, bo: true }),
    },
  ];

  for (const k of kinds) {
    it(`${k.name}: arrivals, batches, batch items and sources show only what the limit allows`, async () => {
      const key = await keyFor(t, ['arrivals:read'], { dataLimit: k.limit() as never, ...(k.source() ? { sourceId: k.source() } : {}) });
      const seen = k.sees();
      const arrivals = await ids(await call(listArrivalsRoute, key, 'arrivals?limit=200'));
      expect(arrivals.includes(ashArrival)).toBe(seen.ash);
      expect(arrivals.includes(boArrival)).toBe(seen.bo);
      const batches = await ids(await call(listBatchesRoute, key, 'batches?limit=200'));
      expect(batches.includes(ashBatch)).toBe(seen.ash);
      expect(batches.includes(boBatch)).toBe(seen.bo);
      expect((await call(itemsRoute, key, `batches/${ashBatch}/items`)).status).toBe(seen.ash ? 200 : 404);
      expect((await call(itemsRoute, key, `batches/${boBatch}/items`)).status).toBe(seen.bo ? 200 : 404);
      const sources = await ids(await call(listSourcesRoute, key, 'sources?limit=200'));
      expect(sources.includes(bo.agentId)).toBe(seen.bo);
      expect(sources.includes(ash.agentId)).toBe(seen.ash);
    });
  }
});

// Slow: runs in CI only (the repo's convention).
describe.skipIf(!process.env.CI)('performance', () => {
  it('API-E2-S1-AC1: POST /arrivals p95 is under 300 ms over 50 calls', async () => {
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      const res = await call(postArrival, ashKey, 'arrivals', { body: validArrival() });
      times.push(performance.now() - started);
      expect(res.status).toBe(202);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(times.length * 0.95) - 1]).toBeLessThan(300);
  });
});
