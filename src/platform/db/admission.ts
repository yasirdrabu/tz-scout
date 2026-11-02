import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Admission to a connection pool for transactions that may open another on the same pool while they
 * run (a request whose gateway call writes its call log in a transaction of its own, say). If every
 * connection were held by such a transaction, each waiting for one more, none would ever finish.
 * So at most `size - 1` top-level transactions run on a pool of `size` at once, which always leaves
 * one connection for the nested ones; a nested transaction (one started inside an admitted one, on the
 * same pool) goes straight in. The rest wait their turn.
 */

class Gate {
  private waiting: (() => void)[] = [];
  private used = 0;
  constructor(public size: number) {}
  async enter(): Promise<void> {
    if (this.used < this.size) {
      this.used++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }
  leave(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.used--;
  }
}

const gates = new Map<string, Gate>();
// The pools the current async chain was admitted to.
const inside = new AsyncLocalStorage<ReadonlySet<string>>();

/** Runs `fn` once admitted to pool `key` of `poolSize` connections (see above). */
export async function admitted<T>(key: string, poolSize: number, fn: () => Promise<T>): Promise<T> {
  const held = inside.getStore();
  if (held?.has(key)) return fn();
  let gate = gates.get(key);
  if (!gate) gates.set(key, (gate = new Gate(Math.max(1, poolSize - 1))));
  gate.size = Math.max(1, poolSize - 1);
  await gate.enter();
  try {
    return await inside.run(new Set([...(held ?? []), key]), fn);
  } finally {
    gate.leave();
  }
}
