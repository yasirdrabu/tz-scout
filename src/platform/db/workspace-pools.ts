import type { Db } from './client';

/** One opened pool and how to close it. */
export type Opened = { db: Db; end: () => Promise<void> };

/** How the pools of `per_workspace` mode are sized (config: SCOUT_WORKSPACE_POOL_MAX, SCOUT_WORKSPACE_POOL_CAP). */
export type PoolLimits = {
  /** Connections in a workspace's `app` pool. Its `admin` pool has one. */
  max: number;
  /** Workspace connections this process may hold across every pool. */
  cap: number;
  /** A pool unused this long is closed. */
  idleMs: number;
};

/** A pool used within this long is never closed to make room: something may still hold it. */
const IN_USE_MS = 10_000;

type Entry = { app: Opened; admin: Opened; lastUsed: number };

/**
 * The per-workspace pools of one process (D35): opened lazily, one `app` pool of `max` connections and
 * one `admin` pool of 1 per workspace database, so each workspace may hold `max + 1` connections and
 * at most `floor(cap / (max + 1))` workspaces have pools at once. Opening one more closes the least
 * recently used pool not used in the last 10 seconds; when every pool is that recent the cap is
 * exceeded for a while rather than closing a pool something holds (logged by the caller through
 * `overCap`). Pools unused for `idleMs` close on `closeIdle`.
 */
export class WorkspacePools {
  private entries = new Map<string, Entry>();

  constructor(
    private open: (database: string, role: 'app' | 'admin', max: number) => Opened,
    private limits: () => PoolLimits,
    private now: () => number = Date.now,
    private overCap: (open: number, allowed: number) => void = () => {},
  ) {}

  /** The most workspaces with pools at once. */
  allowed(): number {
    const { max, cap } = this.limits();
    return Math.max(1, Math.floor(cap / (max + 1)));
  }

  /** The pools of `database`, opened when needed. */
  get(database: string): { app: Db; admin: Db } {
    let e = this.entries.get(database);
    if (!e) {
      this.makeRoom();
      const { max } = this.limits();
      e = { app: this.open(database, 'app', max), admin: this.open(database, 'admin', 1), lastUsed: 0 };
      this.entries.set(database, e);
    }
    e.lastUsed = this.now();
    return { app: e.app.db, admin: e.admin.db };
  }

  private makeRoom(): void {
    const allowed = this.allowed();
    while (this.entries.size >= allowed) {
      const idle = [...this.entries].filter(([, e]) => this.now() - e.lastUsed >= IN_USE_MS).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const oldest = idle[0];
      if (!oldest) {
        this.overCap(this.entries.size + 1, allowed);
        return;
      }
      this.close(oldest[0]);
    }
  }

  private close(database: string): Promise<unknown> {
    const e = this.entries.get(database);
    if (!e) return Promise.resolve();
    this.entries.delete(database);
    return Promise.allSettled([e.app.end(), e.admin.end()]);
  }

  /** Closes the pools unused for `idleMs`. */
  async closeIdle(): Promise<void> {
    const { idleMs } = this.limits();
    const stale = [...this.entries].filter(([, e]) => this.now() - e.lastUsed >= idleMs).map(([d]) => d);
    await Promise.all(stale.map((d) => this.close(d)));
  }

  /** Closes one database's pools (it is being dropped or moved), or every pool. */
  async closeAll(database?: string): Promise<void> {
    const which = database ? [database] : [...this.entries.keys()];
    await Promise.all(which.map((d) => this.close(d)));
  }

  /** Databases with open pools, least recently used first. */
  openDatabases(): string[] {
    return [...this.entries].sort((a, b) => a[1].lastUsed - b[1].lastUsed).map(([d]) => d);
  }
}

/** `url` with its database name replaced by `database`. */
export function urlForDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}
