// R3a Ruling 4: the cost categories. Integrations keeps them here; analytics imports them.

export const COST_CATEGORIES = [
  { key: 'partner_fees', label: 'Partner fees' },
  { key: 'data_vendors', label: 'Data vendors' },
  { key: 'agents_hosting', label: 'Agents and hosting' },
  { key: 'lists_events', label: 'Lists and events' },
  { key: 'ai_usage', label: 'AI usage' },
] as const;

export type CostCategory = (typeof COST_CATEGORIES)[number]['key'];

/** The category a paid provider's usage lands in. */
export const CATEGORY_OF_PROVIDER: Readonly<Record<string, CostCategory>> = {
  anthropic: 'ai_usage',
  apollo: 'data_vendors',
  vibe: 'data_vendors',
};

/** The categories whose paid calls pause at 110% of the budget. */
export const PAUSABLE: ReadonlySet<CostCategory> = new Set<CostCategory>(['ai_usage', 'data_vendors']);
