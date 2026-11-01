import type { ModuleContext } from '@/platform/context';
import type { HandoffPackage } from './types';

// Ports CRM defines and higher modules implement (Playbooks, later). The composition root
// (src/entry/compose.ts) registers implementations; until then the default applies.

export interface HandoffPackageProvider {
  package(ctx: ModuleContext, accountId: string, assignmentId: string): Promise<HandoffPackage | null>;
  /**
   * The offer each account leads with, by name (null when none), for the weekly batch messages: a light read with
   * no brief and no package. Optional: without it the messages name no offer.
   */
  bestOfferNames?(ctx: ModuleContext, accountIds: string[]): Promise<Map<string, string | null>>;
}

const defaultProvider: HandoffPackageProvider = { package: async () => null };

let provider: HandoffPackageProvider | null = null;

/** Pass null to clear (tests). */
export function registerHandoffPackageProvider(p: HandoffPackageProvider | null): void {
  provider = p;
}

export const handoffPackageProvider = (): HandoffPackageProvider => provider ?? defaultProvider;
