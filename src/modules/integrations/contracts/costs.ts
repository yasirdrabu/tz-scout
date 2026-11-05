// R3a Ruling 4: the cost categories. Integrations keeps them here; analytics imports them.

export const COST_CATEGORIES = [
  { key: 'partner_fees', label: 'Partner fees' },
  { key: 'data_vendors', label: 'Data vendors' },
  { key: 'agents_hosting', label: 'Agents and hosting' },
  { key: 'lists_events', label: 'Lists and events' },
  { key: 'ai_usage', label: 'AI usage' },
] as const;

export type CostCategory = (typeof COST_CATEGORIES)[number]['key'];

/** A category's label, e.g. "AI usage". */
export const categoryLabel = (category: CostCategory): string => COST_CATEGORIES.find((c) => c.key === category)!.label;

/** The category a paid provider's usage lands in. */
export const CATEGORY_OF_PROVIDER: Readonly<Record<string, CostCategory>> = {
  anthropic: 'ai_usage',
  apollo: 'data_vendors',
  vibe: 'data_vendors',
};

/** Money per credit when neither a saved rate nor the connection's settings set one (R3a Ruling 1). */
export const DEFAULT_CENTS_PER_CREDIT: Readonly<Record<string, number>> = { apollo: 10, vibe: 10 };

/** The categories whose paid calls pause at 110% of the budget. */
export const PAUSABLE: ReadonlySet<CostCategory> = new Set<CostCategory>(['ai_usage', 'data_vendors']);
