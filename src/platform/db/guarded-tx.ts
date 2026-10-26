import { PostgresJsSession, PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import type { Tx } from './tenant';

export class TransactionClosedError extends Error {
  override name = 'TransactionClosedError';
}

type Closed = { reason?: string };

// The postgres.js transaction `sql`. Typed loosely: we only forward calls to it.
type Client = ((...args: unknown[]) => unknown) & Record<string | symbol, unknown>;

function guardClient(client: Client, closed: Closed): Client {
  const check = () => {
    if (closed.reason !== undefined) throw new TransactionClosedError(closed.reason);
  };
  return new Proxy(client, {
    apply(target, thisArg, args) {
      check();
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        check();
        if (prop === 'savepoint') {
          // Nested transactions get their own client; guard it with the same flag.
          const i = args.length - 1;
          const fn = args[i] as (c: Client) => unknown;
          args[i] = (c: Client) => fn(guardClient(c, closed));
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * A copy of `tx` whose every statement fails with TransactionClosedError once `close()` is
 * called. Drizzle reads `session.client` when a query runs (not when the builder is made), so
 * builders created before the close fail too. Use it for code that may outlive the transaction
 * (a handler abandoned after its time limit): without it, a late statement would run on the
 * pooled connection after it went back to the pool, possibly inside another tenant's transaction.
 */
export function guardTx(tx: Tx): { tx: Tx; close: (reason: string) => void } {
  const closed: Closed = {};
  const raw = tx as unknown as {
    dialect: unknown;
    session: { client: Client; schema: unknown; options: unknown };
    schema: unknown;
  };
  const Session = PostgresJsSession as unknown as new (c: Client, d: unknown, s: unknown, o: unknown) => unknown;
  const Transaction = PostgresJsTransaction as unknown as new (d: unknown, s: unknown, sc: unknown) => Tx;
  const session = new Session(guardClient(raw.session.client, closed), raw.dialect, raw.session.schema, raw.session.options);
  const guarded = new Transaction(raw.dialect, session, raw.schema);
  return {
    tx: guarded,
    close: (reason) => {
      closed.reason ??= reason;
    },
  };
}
