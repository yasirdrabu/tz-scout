import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chooseMapping,
  confirmImport,
  createImport,
  deleteMapping,
  headerSignature,
  listMappings,
  previewImport,
  saveMapping,
} from '@/modules/intake';
import { closeDbs } from '@/platform/db/client';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let personId: string;

afterAll(closeDbs);

beforeAll(async () => {
  t = await freshTenant();
  ({ personId } = await personAndAgent(t));
});

const csv = (text: string) => ({ fileName: 'list.csv', contentType: 'text/csv', bytes: Buffer.from(text) });
const col = (header: string, target: string | null) => ({ header, target, confidence: 1, reason: 'Chosen by a person.' });
const asPerson = <T>(fn: Parameters<typeof asSource<T>>[2]) => asSource(t, personId, fn);

describe('header signature', () => {
  it('ignores order, case and spacing', () => {
    expect(headerSignature(['Org Thing', 'Site Link'])).toBe(headerSignature([' site  link', 'ORG THING']));
    expect(headerSignature(['A', 'B'])).not.toBe(headerSignature(['A', 'C']));
  });
});

describe('choosing a mapping', () => {
  it('SRC-E4-S3-AC1: uses header synonyms in mock mode and asks for a confirm', async () => {
    const r = await asPerson((ctx) =>
      chooseMapping(ctx, { sourceId: personId, headers: ['Company', 'Website'], sampleRows: [['Acme', 'acme.com']] }),
    );
    expect(r.origin).toBe('synonyms');
    expect(r.needsConfirm).toBe(true);
    expect(r.mapping.find((c) => c.header === 'Website')?.target).toBe('account.website');
  });

  it('SRC-E4-S2-AC3: reuses a saved mapping when the headers come in a different order', async () => {
    const first = await asPerson((ctx) => createImport(ctx, csv('Org Thing,Site Link\nAcme,acme-saved.com\n')));
    if (first.status !== 'needs_confirm') throw new Error('expected needs_confirm');
    await asPerson((ctx) => confirmImport(ctx, first.id, [col('Org Thing', 'account.name'), col('Site Link', 'account.website')]));

    const second = await asPerson((ctx) => createImport(ctx, csv('Site Link,Org Thing\nbeta-saved.com,Beta\n')));
    expect(second).toMatchObject({ status: 'queued', origin: 'saved' });
  });
});

describe('previewing', () => {
  it('SRC-E4-S3-AC2: returns the first 5 arrivals', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => `Prev ${i},prev-${i}.com`).join('\n');
    const r = await asPerson((ctx) => createImport(ctx, csv(`Company,Website\n${rows}\n`)));
    if (r.status !== 'needs_confirm') throw new Error('expected needs_confirm');
    const preview = await asPerson((ctx) => previewImport(ctx, r.id));
    expect(preview.total).toBe(8);
    expect(preview.arrivals).toHaveLength(5);
    expect(preview.arrivals[0]!.account?.name).toBe('Prev 0');
  });
});

describe('saved mappings', () => {
  it('SRC-E4-S3-AC3: saves, lists and deletes', async () => {
    const headers = ['Thing A', 'Thing B'];
    const saved = await asPerson((ctx) =>
      saveMapping(ctx, { sourceId: personId, headers, mapping: [col('Thing A', 'account.name'), col('Thing B', null)] }),
    );
    const listed = await asPerson((ctx) => listMappings(ctx, personId));
    expect(listed.find((m) => m.id === saved.id)).toMatchObject({ headerSignature: headerSignature(headers) });
    await asPerson((ctx) => deleteMapping(ctx, saved.id));
    expect((await asPerson((ctx) => listMappings(ctx, personId))).some((m) => m.id === saved.id)).toBe(false);
  });
});
