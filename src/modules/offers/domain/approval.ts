/** Fields that define who the offer is for. Editing one on an approved offer sends it back to draft. */
export const BUYER_DEFINITION_FIELDS = [
  'industries',
  'companySizeMin',
  'companySizeMax',
  'revenueMinCents',
  'revenueMaxCents',
  'regions',
  'targetTitles',
  'targetBuyingRoles',
  'excludedDomains',
  'excludedCategories',
] as const;

export const BUYER_DEFINITION_WARNING = 'This sends the offer back to draft until an owner approves it.';

export type ApprovalFields = {
  promise: string;
  targetTitles: string[];
  targetBuyingRoles: string[];
  industries: string[];
  companySizeMin: number | null;
  companySizeMax: number | null;
  typicalDealCents: number | null;
  salesCycleDays: number | null;
};

/** What is still missing before an owner can approve the offer (OFF-E2-S2-AC2). Empty means ready. */
export function approvalProblems(o: ApprovalFields): string[] {
  const problems: string[] = [];
  if (!o.promise.trim()) problems.push('Add a promise before approving.');
  if (o.targetTitles.length === 0 && o.targetBuyingRoles.length === 0) {
    problems.push('Add at least one target title or buying role before approving.');
  }
  if (o.industries.length === 0 && o.companySizeMin === null && o.companySizeMax === null) {
    problems.push('Add industries or a company size range before approving.');
  }
  if (!o.typicalDealCents || o.typicalDealCents <= 0) problems.push('Add a typical deal size before approving.');
  if (!o.salesCycleDays || o.salesCycleDays <= 0) problems.push('Add the sales cycle in days before approving.');
  return problems;
}

/** True when `patch` sets a buyer definition field to a value different from `before`. */
export function affectsMatching(patch: Record<string, unknown>, before: Record<string, unknown>): boolean {
  return BUYER_DEFINITION_FIELDS.some(
    (f) => patch[f] !== undefined && JSON.stringify(patch[f]) !== JSON.stringify(before[f] ?? null),
  );
}
