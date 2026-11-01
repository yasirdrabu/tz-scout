/** The name a person reads for each fact key Scout knows (C6). Form answers and unknown keys are worded from the key. */
export const FACT_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  domain: 'Domain',
  website_url: 'Website',
  linkedin_url: 'LinkedIn page',
  industry: 'Industry',
  industry_key: 'Industry category',
  employees: 'Employees',
  employees_min: 'Fewest employees',
  employees_max: 'Most employees',
  revenue_cents: 'Revenue',
  revenue_min_cents: 'Lowest revenue',
  revenue_max_cents: 'Highest revenue',
  hq_city: 'HQ city',
  hq_state: 'HQ state',
  hq_country: 'HQ country',
  description: 'Description',
  technologies: 'Technologies',
  keywords: 'Keywords',
  parent_domain: 'Parent company website',
  parent_name: 'Parent company',
  headcount_growth_6m: 'Headcount growth over 6 months',
  founded_year: 'Founded',
  first_name: 'First name',
  last_name: 'Last name',
  title: 'Job title',
  seniority: 'Seniority',
  email: 'Email',
  email_status: 'Email status',
  phone: 'Phone',
  mobile_phone: 'Mobile phone',
  decision_note: 'Decision note',
  hook: 'Hook',
  problem: 'Problem',
  pilot: 'Pilot',
  price_cents: 'Price',
  value_hypothesis: 'Value hypothesis',
  incumbent: 'Incumbent',
  caveats: 'Caveats',
  contact_route: 'Contact route',
  next_action: 'Next action',
  researcher_score: 'Researcher score',
  researcher_tier: 'Researcher tier',
  contract_value_cents: 'Contract value',
  budget_cents: 'Budget',
};

function sentenceCase(words: string): string {
  const s = words.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** `buying_process` gives "Buying process"; `form.<name>` gives the name in sentence case. */
export function factLabel(key: string): string {
  const known = FACT_LABELS[key];
  if (known) return known;
  if (key.startsWith('form.') && key.length > 5) return sentenceCase(key.slice(5));
  return sentenceCase(key) || key;
}
