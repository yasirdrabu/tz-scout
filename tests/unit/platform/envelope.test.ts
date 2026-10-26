import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvelopeSchema } from '@/platform/events/envelope';
import { defineEvent, defineJob } from '@/platform/events/registry';

const valid = {
  id: 'evt_01J',
  type: 'tenancy.member.added',
  schemaVersion: 1,
  tenantId: 't_A',
  occurredAt: '2026-10-25T14:03:11.120Z',
  actor: { kind: 'system', id: 'system' },
  correlationId: 'cor_01J',
  data: {},
};

describe('EnvelopeSchema', () => {
  it('accepts a valid envelope', () => {
    expect(EnvelopeSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects an envelope missing correlationId', () => {
    const { correlationId: _c, ...rest } = valid;
    expect(EnvelopeSchema.safeParse(rest).success).toBe(false);
  });
});

describe('registry', () => {
  it('rejects a bad event type', () => {
    expect(() => defineEvent('Bad.Type', 1, z.object({}))).toThrow();
  });
  it('rejects a bad job name', () => {
    expect(() => defineJob('nodots', z.object({}))).toThrow();
  });
  it('registers and looks up', async () => {
    const { eventDef, jobDef } = await import('@/platform/events/registry');
    const e = defineEvent('unit.thing.done', 1, z.object({}));
    const j = defineJob('unit.do_thing', z.object({}));
    expect(eventDef('unit.thing.done')).toBe(e);
    expect(jobDef('unit.do_thing')).toBe(j);
  });
});
