import { describe, expect, it } from 'vitest';
import { CREDIT_WINDOW_MS, creditedSteps } from '@/modules/playbooks/domain/credit';

const at = new Date('2026-11-07T12:00:00Z');
const step = (id: string, doneAt: Date | null, over: { channel?: string; status?: string } = {}) => ({ id, channel: over.channel ?? 'email', status: over.status ?? 'done', doneAt });

describe('creditedSteps', () => {
  it('credits a done step exactly 14 days before', () => {
    expect(creditedSteps([step('stp_a', new Date(at.getTime() - CREDIT_WINDOW_MS), { channel: 'call' })], at)).toEqual([{ stepId: 'stp_a', channel: 'call' }]);
  });

  it('skips a step done 14 days and 1 ms before', () => {
    expect(creditedSteps([step('stp_a', new Date(at.getTime() - CREDIT_WINDOW_MS - 1))], at)).toEqual([]);
  });

  it('skips a step done after the outcome', () => {
    expect(creditedSteps([step('stp_a', new Date(at.getTime() + 1)), step('stp_b', at)], at)).toEqual([{ stepId: 'stp_b', channel: 'email' }]);
  });

  it('skips skipped and open steps', () => {
    const recent = new Date(at.getTime() - 86_400_000);
    const steps = [step('stp_a', recent, { status: 'skipped' }), step('stp_b', recent, { status: 'todo' }), step('stp_c', recent, { status: 'in_progress' }), step('stp_d', null)];
    expect(creditedSteps(steps, at)).toEqual([]);
  });

  it('orders by doneAt then id', () => {
    const d1 = new Date(at.getTime() - 2 * 86_400_000);
    const d2 = new Date(at.getTime() - 86_400_000);
    const out = creditedSteps([step('stp_c', d2), step('stp_b', d1), step('stp_a', d1, { channel: 'linkedin' })], at);
    expect(out.map((s) => s.stepId)).toEqual(['stp_a', 'stp_b', 'stp_c']);
  });

  it('returns [] when nothing is recent', () => {
    expect(creditedSteps([step('stp_a', new Date(at.getTime() - 30 * 86_400_000))], at)).toEqual([]);
    expect(creditedSteps([], at)).toEqual([]);
  });
});
