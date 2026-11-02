import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModuleContext } from '@/platform/context';
import { controlTxServes, isControlTx, withControlAdmin, withControlTenant } from '@/platform/db/doors';
import type { Tx } from '@/platform/db/tenant';

/**
 * Tenancy lives on the control plane (D35). Public functions still take the caller's context (for
 * the tenant and actor), but their SQL never runs on its `ctx.tx`, which is a workspace transaction.
 * The workspace transaction stays for what belongs there: audit rows, and calls into workspace modules
 * such as the source validator.
 */

// The control transaction open for a tenant in this call chain, so nested tenancy calls share it.
const open = new AsyncLocalStorage<{ tenantId: string; tx: Tx }>();

/**
 * Runs `fn` with a copy of `ctx` whose `tx` is a control-plane transaction for `ctx.tenantId`: the one
 * an outer tenancy call opened, else `ctx.tx` when it is already one (a tenancy-owned route's), else a
 * new one with `app.tenant_id` set. It commits before the caller's workspace transaction does.
 */
export function onControl<T>(ctx: ModuleContext, fn: (control: ModuleContext) => Promise<T>): Promise<T> {
  const current = open.getStore();
  if (current?.tenantId === ctx.tenantId) return fn({ ...ctx, tx: current.tx });
  const run = (tx: Tx) => open.run({ tenantId: ctx.tenantId, tx }, () => fn({ ...ctx, tx }));
  if (controlTxServes(ctx.tx, ctx.tenantId)) return run(ctx.tx);
  return withControlTenant(ctx.tenantId, run);
}

/** `onControl` in a savepoint of the control transaction, so a refusal inside leaves the rest of its work in place. */
export function onControlSavepoint<T>(ctx: ModuleContext, fn: () => Promise<T>): Promise<T> {
  return onControl(ctx, (c) => c.tx.transaction((sp) => open.run({ tenantId: ctx.tenantId, tx: sp }, fn)));
}

/** For platform-wide rows (people, sessions) a caller reads with its own `tx`: that one when it is a control transaction, else a new admin one. */
export function onControlTx<T>(tx: Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return isControlTx(tx) || open.getStore()?.tx === tx ? fn(tx) : withControlAdmin(fn);
}
