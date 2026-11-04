import { describe, expect, it } from 'vitest';
import { dueFlags, pickNextStep } from '@/modules/playbooks/domain/next-step';

const step = (id: string, status: string, dueDate: string, order: number) => ({ id, status, dueDate, order });

describe('pickNextStep', () => {
  it('is the earliest due open step, then the lowest order', () => {
    const steps = [
      step('a', 'done', '2026-11-02', 1),
      step('b', 'todo', '2026-11-10', 3),
      step('c', 'in_progress', '2026-11-09', 4),
      step('d', 'todo', '2026-11-09', 2),
      step('e', 'skipped', '2026-11-01', 5),
    ];
    expect(pickNextStep(steps)?.id).toBe('d');
  });

  it('is null when nothing is open', () => {
    expect(pickNextStep([step('a', 'done', '2026-11-02', 1)])).toBeNull();
    expect(pickNextStep([])).toBeNull();
  });
});

describe('dueFlags', () => {
  it('judges against today', () => {
    expect(dueFlags('2026-11-03', '2026-11-04')).toEqual({ overdue: true, dueToday: false });
    expect(dueFlags('2026-11-04', '2026-11-04')).toEqual({ overdue: false, dueToday: true });
    expect(dueFlags('2026-11-05', '2026-11-04')).toEqual({ overdue: false, dueToday: false });
  });
});
