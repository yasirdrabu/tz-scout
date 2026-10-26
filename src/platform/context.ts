import type { Tx } from './db/tenant';
import type { Actor } from './events/envelope';

/** Passed to every module service call: who, for which tenant, and the open transaction. */
export type ModuleContext = {
  tenantId: string;
  actor: Actor;
  correlationId: string;
  causationId?: string;
  tx: Tx;
  /** Set when the caller authenticated with an API key. Test keys only ever get mock adapters. */
  environment?: 'live' | 'test';
};
