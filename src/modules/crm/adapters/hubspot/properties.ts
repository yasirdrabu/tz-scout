// Scout's company properties in HubSpot, so reps can filter and sort on why an account is a lead.
// They live in one property group. Creating them changes HubSpot settings, so it only happens from
// "Set up HubSpot fields", on purpose. The `taazaa_*` names are v1's, kept so v1 properties map unchanged.

export const PROPERTY_GROUP = { name: 'scout_buyer_signals', label: 'Scout buyer signals' } as const;

export type PropertyFieldType = 'text' | 'textarea' | 'number' | 'select' | 'date';
export type PropertyDef = {
  name: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'enumeration';
  fieldType: PropertyFieldType;
  description: string;
  options?: string[];
};

export const TIER_OPTIONS = ['Act now', 'Good fit', 'Watch', 'Not a fit'];

export const SCOUT_PROPERTIES: PropertyDef[] = [
  { name: 'taazaa_bucket', label: 'Taazaa practice', type: 'string', fieldType: 'text', description: 'The practice line(s) this company was researched for: AI Transformation, AI Operating Platforms, Data & Engineering, AI Marketing Studio.' },
  { name: 'taazaa_best_offer', label: 'Best Taazaa offer', type: 'string', fieldType: 'text', description: 'The offer this company is most likely to buy, from Scout.' },
  { name: 'taazaa_tier', label: 'Buying tier', type: 'enumeration', fieldType: 'select', description: 'Act now: strong fit and a reason to buy now. Good fit: fits, no trigger yet.', options: TIER_OPTIONS },
  { name: 'taazaa_fit_score', label: 'Fit score', type: 'number', fieldType: 'number', description: '0 to 100: how much this company looks like the offer\'s buyer.' },
  { name: 'taazaa_signal_score', label: 'Buying signal score', type: 'number', fieldType: 'number', description: '0 to 100: research, trigger events and visible pain that say they\'re buying now.' },
  { name: 'taazaa_total_score', label: 'Overall match score', type: 'number', fieldType: 'number', description: 'Fit and signals combined.' },
  { name: 'taazaa_why_now', label: 'Why now', type: 'string', fieldType: 'textarea', description: 'The buying window in a sentence or two.' },
  { name: 'taazaa_top_signals', label: 'Top buying signals', type: 'string', fieldType: 'textarea', description: 'The signals behind the score, strongest first.' },
  { name: 'taazaa_research_topics', label: 'Researching', type: 'string', fieldType: 'text', description: 'Topics this company is actively researching, with research scores.' },
  { name: 'taazaa_last_pushed', label: 'Last pushed from Scout', type: 'date', fieldType: 'date', description: 'When Scout last handed this company off.' },
  { name: 'scout_link', label: 'Scout link', type: 'string', fieldType: 'text', description: 'Link to this company in Scout.' },
];

export const SCOUT_PROPERTY_NAMES = SCOUT_PROPERTIES.map((p) => p.name);
