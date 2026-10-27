import type { ModuleContext } from '@/platform/context';

// Ports Accounts defines and higher modules implement. The composition root (src/entry/compose.ts)
// registers the implementations; until then the defaults below apply.

/** Implemented by intake. */
export interface SourceInfoProvider {
  /** Effective trust (0 to 1) per source id. */
  getTrust(ctx: ModuleContext, sourceIds: string[]): Promise<Map<string, number>>;
  sourcesForAccount(ctx: ModuleContext, accountId: string): Promise<string[]>;
}

/** Implemented by CRM. */
export interface MergeGuard {
  check(
    ctx: ModuleContext,
    survivorId: string,
    mergedId: string,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }>;
}

/** Implemented by intake (Task 12). Defined here so Accounts never imports intake. */
export interface SourceAccessProvider {
  /** Every source below the given ones. */
  childSources(ctx: ModuleContext, sourceIds: string[]): Promise<string[]>;
  /** The person source of a user, if they have one. */
  personSourceFor(ctx: ModuleContext, userId: string): Promise<string | undefined>;
}

const DEFAULT_TRUST = 0.6;

const defaultSourceInfo: SourceInfoProvider = {
  getTrust: async (_ctx, sourceIds) => new Map(sourceIds.map((id) => [id, DEFAULT_TRUST])),
  sourcesForAccount: async () => [],
};
const defaultMergeGuard: MergeGuard = { check: async () => ({ allowed: true }) };
const defaultSourceAccess: SourceAccessProvider = {
  childSources: async () => [],
  personSourceFor: async () => undefined,
};

let sourceInfo: SourceInfoProvider | null = null;
let guard: MergeGuard | null = null;
let sourceAccess: SourceAccessProvider | null = null;

/** Implementations register themselves from the composition root. Pass null to clear (tests). */
export function registerSourceInfoProvider(p: SourceInfoProvider | null): void {
  sourceInfo = p;
}
export function registerMergeGuard(g: MergeGuard | null): void {
  guard = g;
}
export function registerSourceAccessProvider(p: SourceAccessProvider | null): void {
  sourceAccess = p;
}

export const sourceInfoProvider = (): SourceInfoProvider => sourceInfo ?? defaultSourceInfo;
export const mergeGuard = (): MergeGuard => guard ?? defaultMergeGuard;
export const sourceAccessProvider = (): SourceAccessProvider => sourceAccess ?? defaultSourceAccess;
