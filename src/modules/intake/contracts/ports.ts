import type { ModuleContext } from '@/platform/context';

// Ports Intake defines and higher modules implement. The composition root (src/entry/compose.ts)
// registers the implementations; until then the defaults below apply.

/** Implemented by routing. */
export interface ReviewStatusValidator {
  /** True when `key` names an active review status. */
  exists(ctx: ModuleContext, key: string): Promise<boolean>;
}

let reviewStatus: ReviewStatusValidator | null = null;

/** Pass null to clear (tests). */
export function registerReviewStatusValidator(v: ReviewStatusValidator | null): void {
  reviewStatus = v;
}

/** With none registered, any key is accepted. */
export const reviewStatusValidator = (): ReviewStatusValidator =>
  reviewStatus ?? { exists: async () => true };
