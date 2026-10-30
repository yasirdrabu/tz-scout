import type { ModuleContext } from '@/platform/context';

// Ports Routing defines and higher modules implement (CRM, in R1c). The composition root
// (src/entry/compose.ts) registers implementations; until then the default applies.

/**
 * What the CRM preflight says about assigning (REV-E3):
 * new: not in the CRM, or nothing to protect ("New in the CRM"); assign: the seller can take it, with who had it;
 * stop: open deal, customer or an owner we may not take over, so only "Push anyway, keep their owner" is allowed;
 * blocked: the seller has no CRM owner set, so assignment cannot go ahead.
 */
export const PREFLIGHT_RESULTS = ['new', 'assign', 'stop', 'blocked'] as const;
export type PreflightResultKey = (typeof PREFLIGHT_RESULTS)[number];
export type OwnershipPreflightResult = { result: PreflightResultKey; message: string };

/** `fresh` (default true) asks the CRM now; false lets the CRM answer from a check under a day old (a bulk assign). */
export type PreflightOptions = { fresh?: boolean };

export interface OwnershipPreflight {
  check(ctx: ModuleContext, accountId: string, sellerUserId: string, opts?: PreflightOptions): Promise<OwnershipPreflightResult>;
}

const defaultPreflight: OwnershipPreflight = {
  check: async () => ({ result: 'new', message: 'New in the CRM' }),
};

let preflight: OwnershipPreflight | null = null;

/** Pass null to clear (tests). */
export function registerOwnershipPreflight(p: OwnershipPreflight | null): void {
  preflight = p;
}

export const ownershipPreflight = (): OwnershipPreflight => preflight ?? defaultPreflight;
