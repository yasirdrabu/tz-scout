import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachFile, readFile, submitBatch } from '@/modules/intake';
import { closeDbs } from '@/platform/db/client';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let agentId: string;
let zedAgentId: string;
let batchId: string;

afterAll(closeDbs);

const newBatch = async (name: string, domain: string) =>
  (
    await asSource(t, agentId, (ctx) =>
      submitBatch(ctx, { name, items: [{ account: { name, domain } }] }, { channel: 'api' }),
    )
  ).batchId;

beforeAll(async () => {
  t = await freshTenant();
  ({ agentId } = await personAndAgent(t));
  ({ agentId: zedAgentId } = await personAndAgent(t, 'Zed'));
  batchId = await newBatch('With files', 'filed-co.com');
});

const file = (name: string, bytes: Buffer) => ({ fileName: name, contentType: 'text/plain', bytes });

describe('batch files (SRC-E2-S2-AC2)', () => {
  it('records the sha256 and reads the file back', async () => {
    const bytes = Buffer.from('hello scout');
    const stored = await asSource(t, agentId, (ctx) => attachFile(ctx, batchId, file('notes.txt', bytes)));
    expect(stored.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(stored.sizeBytes).toBe(bytes.length);
    const back = await asSource(t, agentId, (ctx) => readFile(ctx, batchId, stored.storageKey));
    expect(back?.fileName).toBe('notes.txt');
    expect(Buffer.from(back!.bytes).toString()).toBe('hello scout');
  });

  it('refuses a file over 25 MB', async () => {
    await expect(
      asSource(t, agentId, (ctx) => attachFile(ctx, batchId, file('big.bin', Buffer.alloc(25 * 1024 * 1024 + 1)))),
    ).rejects.toMatchObject({ status: 400, message: 'Files can be up to 25 MB each.' });
  });

  it('refuses an 11th file', async () => {
    const b = await newBatch('Ten', 'ten-co.com');
    for (let i = 0; i < 10; i++) await asSource(t, agentId, (ctx) => attachFile(ctx, b, file(`f${i}.txt`, Buffer.from(`f${i}`))));
    await expect(asSource(t, agentId, (ctx) => attachFile(ctx, b, file('f10.txt', Buffer.from('x'))))).rejects.toMatchObject({
      status: 400,
      message: 'A batch can have up to 10 files.',
    });
  });

  it("answers 404 for another source's batch", async () => {
    await expect(asSource(t, zedAgentId, (ctx) => attachFile(ctx, batchId, file('x.txt', Buffer.from('x'))))).rejects.toMatchObject({
      status: 404,
    });
  });
});
