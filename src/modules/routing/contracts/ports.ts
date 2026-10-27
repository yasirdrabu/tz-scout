import type { ModuleContext } from '@/platform/context';

// Ports Routing defines and higher modules implement (CRM, in R1c). The composition root
// (src/entry/compose.ts) registers implementations; until then the default applies.

export type OwnershipPreflightResult = { result: 'new' | 'same_owner' | 'other_owner' | 'unknown'; message: string };

export interface OwnershipPreflight {
  check(ctx: ModuleContext, accountId: string, sellerUserId: string): Promise<OwnershipPreflightResult>;
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
