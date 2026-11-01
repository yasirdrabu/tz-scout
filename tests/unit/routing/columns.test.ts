import { describe, expect, it } from 'vitest';
import { columnProblems, columnsView, QUEUE_COLUMNS } from '@/modules/routing/domain/columns';

const all = QUEUE_COLUMNS.map((c) => ({ key: c.key, visible: true }));

describe('queue columns', () => {
  it('defaults to the seven columns screens.md turns on, Account counted', () => {
    const v = columnsView(null);
    expect(v).toMatchObject({ shown: 8, total: 12, isDefault: true });
    expect(v.columns.filter((c) => c.visible).map((c) => c.label)).toEqual(['Best offer', 'Priority', 'Tier', 'Source', 'Review status', 'Flags', 'Notes']);
  });

  it('keeps a saved order and choice', () => {
    const saved = [...all].reverse().map((c, i) => ({ ...c, visible: i < 2 }));
    const v = columnsView(saved);
    expect(v).toMatchObject({ shown: 3, isDefault: false });
    expect(v.columns.slice(0, 2).map((c) => c.label)).toEqual(['Arrived', 'Buying intent']);
  });

  it('wants every column once, and falls back to the default for a stored choice that no longer fits', () => {
    expect(columnProblems(all)).toEqual([]);
    expect(columnProblems(all.slice(1))).toEqual(['List every column once.']);
    expect(columnProblems([...all.slice(1), all[1]!])).toEqual(['List every column once.']);
    expect(columnProblems([...all.slice(1), { key: 'account', visible: true }])).toEqual(['There is no column called account.']);
    expect(columnsView([{ key: 'tier', visible: true }]).isDefault).toBe(true);
  });
});
