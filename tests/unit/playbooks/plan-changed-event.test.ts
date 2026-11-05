import { describe, expect, expectTypeOf, it } from 'vitest';
import { planChanged } from '@/modules/playbooks/contracts/events';

type Step = (typeof planChanged.data)['_output']['steps'][number];

const base = { planId: 'pln_1', accountId: 'acc_1', status: 'active' as const, changed: ['steps' as const] };

describe('playbooks.plan.changed steps', () => {
  it('parses a row stored before steps were full snapshots', () => {
    const old = { ...base, steps: [{ id: 'stp_1', status: 'done' }, { id: 'stp_2', removed: true }, { id: 'stp_3', title: 'Call', dueDate: '2026-11-06' }] };
    expect(planChanged.data.parse(old).steps).toHaveLength(3);
  });

  it('parses the new shapes: a full snapshot and a removed step', () => {
    const snapshot = {
      id: 'stp_1',
      order: 1,
      day: 0,
      channel: 'email' as const,
      title: 'Intro',
      detail: null,
      subject: 'Hi',
      body: null,
      status: 'todo' as const,
      ownerUserId: null,
      dueDate: '2026-11-06',
      crmTask: true,
    };
    const parsed = planChanged.data.parse({ ...base, steps: [snapshot, { id: 'stp_2', removed: true }] });
    expect(parsed.steps).toEqual([snapshot, { id: 'stp_2', removed: true }]);
  });

  it('types a step as a removed id or a full snapshot', () => {
    expectTypeOf<Extract<Step, { removed: true }>>().toEqualTypeOf<{ id: string; removed: true }>();
    expectTypeOf<Extract<Step, { order: number }>['dueDate']>().toEqualTypeOf<string>();
    // @ts-expect-error a snapshot needs every field
    const partial: Step = { id: 'stp_1', status: 'done' };
    expect(partial.id).toBe('stp_1');
  });
});
