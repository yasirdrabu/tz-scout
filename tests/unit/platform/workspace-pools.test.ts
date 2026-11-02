import { describe, expect, it } from 'vitest';
import type { Db } from '@/platform/db/client';
import { urlForDatabase, WorkspacePools, type PoolLimits } from '@/platform/db/workspace-pools';

function fixture(limits: PoolLimits) {
  let now = 1_000_000;
  const opened: string[] = [];
  const ended: string[] = [];
  const overCap: number[] = [];
  const pools = new WorkspacePools(
    (database, role, max) => {
      opened.push(`${database}/${role}/${max}`);
      return { db: { database, role } as unknown as Db, end: async () => void ended.push(`${database}/${role}`) };
    },
    () => limits,
    () => now,
    (open) => overCap.push(open),
  );
  return { pools, opened, ended, overCap, tick: (ms: number) => (now += ms) };
}

describe('per-workspace pools (D35)', () => {
  it('opens an app pool of SCOUT_WORKSPACE_POOL_MAX and an admin pool of 1, once per database', () => {
    const f = fixture({ max: 3, cap: 60, idleMs: 600_000 });
    const a = f.pools.get('scout_t_a');
    expect(f.pools.get('scout_t_a')).toEqual(a);
    expect(f.opened).toEqual(['scout_t_a/app/3', 'scout_t_a/admin/1']);
  });

  it('keeps at most cap / (max + 1) workspaces open, closing the least recently used one', async () => {
    const f = fixture({ max: 3, cap: 8, idleMs: 600_000 }); // 2 workspaces of 4 connections
    expect(f.pools.allowed()).toBe(2);
    f.pools.get('a');
    f.tick(20_000);
    f.pools.get('b');
    f.tick(20_000);
    f.pools.get('a'); // a is now the most recent
    f.tick(20_000);
    f.pools.get('c');
    expect(f.ended).toEqual(['b/app', 'b/admin']);
    expect(f.pools.openDatabases()).toEqual(['a', 'c']);
  });

  it('does not close a pool used in the last 10 seconds to make room; goes over the cap and says so', () => {
    const f = fixture({ max: 3, cap: 4, idleMs: 600_000 }); // 1 workspace
    f.pools.get('a');
    f.tick(1_000);
    f.pools.get('b');
    expect(f.ended).toEqual([]);
    expect(f.overCap).toEqual([2]);
    expect(f.pools.openDatabases()).toEqual(['a', 'b']);
  });

  it('closes pools left unused for the idle time', async () => {
    const f = fixture({ max: 3, cap: 60, idleMs: 600_000 });
    f.pools.get('a');
    f.tick(300_000);
    f.pools.get('b');
    f.tick(300_000);
    await f.pools.closeIdle();
    expect(f.pools.openDatabases()).toEqual(['b']);
    expect(f.ended).toEqual(['a/app', 'a/admin']);
  });

  it('puts the workspace database in a connection URL', () => {
    expect(urlForDatabase('postgres://scout_app:pw@db.local:5432/scout?sslmode=require', 'scout_t_01abc')).toBe(
      'postgres://scout_app:pw@db.local:5432/scout_t_01abc?sslmode=require',
    );
  });
});
