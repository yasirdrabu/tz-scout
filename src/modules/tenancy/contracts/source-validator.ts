import type { ModuleContext } from '@/platform/context';

/** Lets the tenancy module ask whether a source exists, without importing the sources module. */
export interface SourceValidator {
  exists(ctx: ModuleContext, sourceId: string): Promise<boolean>;
}

let validator: SourceValidator | null = null;

/** Sources register themselves here when they arrive. Pass null to clear (tests). */
export function registerSourceValidator(v: SourceValidator | null): void {
  validator = v;
}

export function sourceValidator(): SourceValidator | null {
  return validator;
}
