import { guardWorkspaceTransactions } from './helpers/tenancy-guard';

// D35: tenancy lives on the control plane. Every workspace transaction in the integration suite
// refuses SQL on a `tenancy.*` table, so tenancy code that still uses the caller's `ctx.tx` fails.
guardWorkspaceTransactions();
