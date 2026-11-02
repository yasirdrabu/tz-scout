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

/** Implemented by routing. */
export interface FunnelStages {
  /** The workspace's stages, flow then exits; `assigned` marks the ones at or past the assignment being accepted. */
  stages(ctx: ModuleContext): Promise<{ key: string; assigned: boolean }[]>;
}

let funnel: FunnelStages | null = null;

/** Pass null to clear (tests). */
export function registerFunnelStages(f: FunnelStages | null): void {
  funnel = f;
}

/** With none registered, the funnel lists no stages. */
export const funnelStages = (): FunnelStages => funnel ?? { stages: async () => [] };
