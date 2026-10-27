import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as postImport } from '@/app/v1/imports/route';
import { GET as getImportRoute, POST as importAction } from '@/app/v1/imports/[id]/route';
import { closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { call, freshTenant, keyFor, personAndAgent, uploadForm, type Tenant } from './intake-helpers';

let t: Tenant;
let ashKey: string;
let boKey: string;

beforeAll(async () => {
  t = await freshTenant();
  const ash = await personAndAgent(t, 'Ash');
  const bo = await personAndAgent(t, 'Bo');
  const scopes = ['imports:run', 'arrivals:write', 'arrivals:read'] as const;
  ashKey = await keyFor(t, [...scopes], { sourceId: ash.agentId });
  boKey = await keyFor(t, [...scopes], { sourceId: bo.agentId });
});
afterAll(closeDbs);

const fixture = (name: string) => readFileSync(join(__dirname, '../../fixtures/imports', name));
let n = 0;

describe('/v1/imports', () => {
  it('SRC-E4-S4-AC3: a research file is queued, runs and reports its counts', async () => {
    const res = await call(postImport, ashKey, 'imports', { body: uploadForm('research.csv', fixture('research-master.csv')) });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ import_id: expect.stringMatching(/^imp_/), status: 'queued', needs_confirm: false });
    expect(Array.isArray(body.proposed_mapping)).toBe(true);
    await runOutbox(t.tenantId);
    const done = await (await call(getImportRoute, ashKey, `imports/${body.import_id}`)).json();
    expect(done).toMatchObject({ status: 'imported', stats: { companies: 2, created: 2 } });
    expect(done.file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SRC-E4-S4-AC3: an unknown layout needs confirmation, then preview, then confirm', async () => {
    const k = `${Date.now().toString(36)}${++n}`;
    const csv = `Company ${k},Website ${k}\nNovel Co,novel-${k}.com\nOther Co,other-${k}.com\n`;
    const res = await call(postImport, ashKey, 'imports', { body: uploadForm('novel.csv', csv) });
    expect(res.status).toBe(202);
    const created = await res.json();
    expect(created).toMatchObject({ status: 'needs_confirm', needs_confirm: true });
    const id = created.import_id;

    const mapping = [
      { header: `Company ${k}`, target: 'account.name' },
      { header: `Website ${k}`, target: 'account.website' },
    ];
    const preview = await call(importAction, ashKey, `imports/${id}:preview`, { body: { mapping } });
    expect(preview.status).toBe(200);
    const shown = await preview.json();
    expect(shown.total).toBe(2);
    expect(shown.arrivals[0].account.name).toBe('Novel Co');
    expect((await call(importAction, ashKey, `imports/${id}:preview`, { method: 'POST' })).status).toBe(200);

    expect((await call(importAction, ashKey, `imports/${id}:confirm`, { body: { mapping: [{ header: 'x', target: null }] } })).status).toBe(400);
    const confirmed = await call(importAction, ashKey, `imports/${id}:confirm`, { body: { mapping } });
    expect(confirmed.status).toBe(202);
    expect(await confirmed.json()).toMatchObject({ import_id: id, status: 'queued' });
    expect((await call(importAction, ashKey, `imports/${id}:confirm`, { body: { mapping } })).status).toBe(409);

    await runOutbox(t.tenantId);
    expect(await (await call(getImportRoute, ashKey, `imports/${id}`)).json()).toMatchObject({ status: 'imported', stats: { created: 2 } });
  });

  it('hides another source import with a 404 and refuses unknown actions', async () => {
    const k = `${Date.now().toString(36)}${++n}`;
    const created = await (await call(postImport, ashKey, 'imports', { body: uploadForm('a.csv', `Co ${k},Site ${k}\nA,a-${k}.com\n`) })).json();
    expect((await call(getImportRoute, boKey, `imports/${created.import_id}`)).status).toBe(404);
    expect((await call(importAction, boKey, `imports/${created.import_id}:preview`, { method: 'POST' })).status).toBe(404);
    expect((await call(importAction, ashKey, `imports/${created.import_id}:explode`, { method: 'POST' })).status).toBe(404);
  });

  it('asks for a sheet and refuses a missing file or an unknown field', async () => {
    const noFile = new FormData();
    noFile.set('sheet', 'x');
    expect((await call(postImport, ashKey, 'imports', { body: noFile })).status).toBe(400);
    expect((await call(postImport, ashKey, 'imports', { body: uploadForm('a.csv', 'a,b\n1,2\n', { surprise: '1' }) })).status).toBe(400);
  });

  it('needs imports:run', async () => {
    const key = await keyFor(t, ['arrivals:read']);
    expect((await call(postImport, key, 'imports', { body: uploadForm('a.csv', 'a,b\n1,2\n') })).status).toBe(403);
  });
});
