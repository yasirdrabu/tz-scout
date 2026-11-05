import { describe, expect, it } from 'vitest';
import type { PlanTasks } from '@/modules/crm/contracts/types';
import { dueAtOn, planTaskSpec } from '@/modules/crm/domain/tasks';

type Step = PlanTasks['steps'][number];
const step = (over: Partial<Step>): Step => ({
  id: 'stp_1',
  channel: 'email',
  title: 'Intro email',
  detail: null,
  subject: null,
  body: null,
  status: 'todo',
  ownerUserId: null,
  dueDate: '2026-11-18',
  crmTask: true,
  personIds: [],
  ...over,
});
const scoutUrl = 'https://x/t/taazaa/accounts/acc_1';
const from = `From the Standard outbound playbook in Scout: ${scoutUrl}`;

describe('dueAtOn', () => {
  it('is 17:00 in the tenant timezone on the date', () => {
    expect(dueAtOn('2026-11-18', 'America/New_York')).toBe('2026-11-18T22:00:00.000Z');
    expect(dueAtOn('2026-11-18', 'Asia/Kolkata')).toBe('2026-11-18T11:30:00.000Z');
  });
});

describe('planTaskSpec', () => {
  it('an email step with a draft carries the draft', () => {
    const spec = planTaskSpec({ step: step({ subject: 'Hello', body: 'Hi Ana' }), accountName: 'Acme', playbookName: 'Standard outbound', scoutUrl });
    expect(spec.subject).toBe('Intro email (Acme)');
    expect(spec.body).toBe(`Draft email (send it yourself)\n\nSubject: Hello\n\nHi Ana\n\n${from}`);
  });

  it('a call step carries its detail', () => {
    const spec = planTaskSpec({ step: step({ channel: 'call', title: 'Call Ana', detail: 'Ask about the pilot.' }), accountName: 'Acme', playbookName: 'Standard outbound', scoutUrl });
    expect(spec.subject).toBe('Call Ana (Acme)');
    expect(spec.body).toBe(`Ask about the pilot.\n\n${from}`);
  });

  it('a step with no draft or detail has only the playbook line', () => {
    expect(planTaskSpec({ step: step({ channel: 'task', title: 'Research' }), accountName: 'Acme', playbookName: 'Standard outbound', scoutUrl }).body).toBe(from);
  });
});
