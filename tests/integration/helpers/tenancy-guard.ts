import { PostgresJsSession, PostgresJsTransaction } from 'drizzle-orm/postgres-js';
import { setWorkspaceTxWrapper } from '@/platform/db/doors';
import type { Tx } from '@/platform/db/tenant';

/** Thrown when SQL naming a `tenancy.*` table runs on a workspace transaction (D35: tenancy lives on the control plane). */
export class TenancyOnWorkspaceTx extends Error {
  override name = 'TenancyOnWorkspaceTx';
}

const TENANCY = /(^|[^a-z0-9_$])"?tenancy"?\s*\./i;

// The postgres.js transaction `sql`. Drizzle runs every statement through `unsafe(query, params)`.
type Client = ((...args: unknown[]) => unknown) & Record<string | symbol, unknown>;

function guardClient(client: Client): Client {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (prop === 'unsafe' && typeof args[0] === 'string' && TENANCY.test(args[0])) {
          throw new TenancyOnWorkspaceTx(`tenancy SQL on a workspace transaction: ${args[0].slice(0, 200)}`);
        }
        if (prop === 'savepoint') {
          const i = args.length - 1;
          const fn = args[i] as (c: Client) => unknown;
          args[i] = (c: Client) => fn(guardClient(c));
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** A copy of the workspace transaction `tx` that refuses any statement naming a `tenancy.*` table. */
export function refuseTenancySql(tx: Tx): Tx {
  const raw = tx as unknown as {
    dialect: unknown;
    session: { client: Client; schema: unknown; options: unknown };
    schema: unknown;
  };
  const Session = PostgresJsSession as unknown as new (c: Client, d: unknown, s: unknown, o: unknown) => unknown;
  const Transaction = PostgresJsTransaction as unknown as new (d: unknown, s: unknown, sc: unknown) => Tx;
  const session = new Session(guardClient(raw.session.client), raw.dialect, raw.session.schema, raw.session.options);
  return new Transaction(raw.dialect, session, raw.schema);
}

/** Turns the guard on for every workspace transaction (`withTenant`, `withWorkspaceAdmin`) in this test file. */
export function guardWorkspaceTransactions(): void {
  setWorkspaceTxWrapper(refuseTenancySql);
}
