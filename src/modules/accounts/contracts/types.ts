// DTO types other modules see. They never see this module's tables.

/** Who said it, at each level. Any level may be missing. */
export type SourceChain = { personSourceId?: string; agentSourceId?: string; vendorSourceId?: string };

export type FactKind = 'firmographic' | 'contact' | 'research' | 'custom' | 'form_answer';
export type SignalKind = 'research' | 'trigger' | 'pain';
export type CrmStatus = 'none' | 'open_deal' | 'customer';
export type RoleOrigin = 'stated' | 'guessed_from_title' | 'set_by_person';

export type PersonView = {
  id: string;
  accountId: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  seniority: string | null;
  email: string | null;
  emailStatus: string | null;
  phone: string | null;
  mobilePhone: string | null;
  linkedinUrl: string | null;
  isPrimary: boolean;
  decisionNote: string | null;
  roles: { key: string; origin: RoleOrigin }[];
};

export type AccountView = {
  id: string;
  name: string;
  domain: string | null;
  websiteUrl: string | null;
  linkedinUrl: string | null;
  industry: string | null;
  industryKey: string | null;
  employees: number | null;
  employeesMin: number | null;
  employeesMax: number | null;
  revenueCents: number | null;
  revenueMinCents: number | null;
  revenueMaxCents: number | null;
  hqCity: string | null;
  hqState: string | null;
  hqStateKey: string | null;
  hqCountry: string | null;
  description: string | null;
  technologies: string[];
  keywords: string[];
  parentDomain: string | null;
  headcountGrowth6m: number | null;
  foundedYear: number | null;
  isShell: boolean;
  researchTier: 'A' | 'B' | 'C' | null;
  researchTierSignalAt: Date | null;
  practiceIds: string[];
  excludedReasonKey: string | null;
  excludedOverride: boolean;
  crmStatus: CrmStatus;
  archivedAt: Date | null;
  createdAt: Date;
  people: PersonView[];
  aliases: { kind: string; value: string; system: string }[];
};

export type FactView = {
  id: string;
  accountId: string;
  personId: string | null;
  key: string;
  value: unknown;
  valueType: string;
  kind: FactKind;
  sourceChain: SourceChain;
  arrivalId: string | null;
  url: string | null;
  note: string | null;
  observedAt: Date;
  recordedAt: Date;
  status: 'current' | 'candidate' | 'superseded' | 'archived';
  pinnedBy: string | null;
  pinnedAt: Date | null;
};

export type SignalView = {
  id: string;
  accountId: string;
  type: string | null;
  kind: SignalKind;
  title: string;
  detail: string | null;
  url: string | null;
  value: unknown;
  occurredAt: Date | null;
  sourceChain: SourceChain;
  arrivalId: string | null;
  externalId: string | null;
  recordedAt: Date;
  archivedAt: Date | null;
};

/** Account fields an arrival may carry, already normalised by intake. */
export type ArrivalAccountFields = {
  name?: string;
  domain?: string;
  websiteUrl?: string;
  linkedinUrl?: string;
  industry?: string;
  industryKey?: string;
  employees?: number;
  employeesMin?: number;
  employeesMax?: number;
  revenueCents?: number;
  revenueMinCents?: number;
  revenueMaxCents?: number;
  hqCity?: string;
  hqState?: string;
  hqCountry?: string;
  description?: string;
  technologies?: string[];
  keywords?: string[];
  parentDomain?: string;
  headcountGrowth6m?: number;
  foundedYear?: number;
};

export type ArrivalPerson = {
  firstName?: string;
  lastName?: string;
  title?: string;
  seniority?: string;
  email?: string;
  emailStatus?: string;
  phone?: string;
  mobilePhone?: string;
  linkedinUrl?: string;
  roleKeys?: string[];
  decisionNote?: string;
};

export type ArrivalSignal = {
  type?: string;
  kind: SignalKind;
  title: string;
  detail?: string;
  url?: string;
  value?: unknown;
  /** Required unless `kind` is `research`. */
  occurredAt?: Date;
  externalId?: string;
};

export type ArrivalFact = {
  key: string;
  value: unknown;
  /** Set when the fact is about one of `people`, by index. */
  personIndex?: number;
  url?: string;
  note?: string;
  observedAt?: Date;
};

/** What Accounts needs from a resolved arrival. Intake builds it; Accounts never reads intake tables. */
export type ArrivalForAccounts = {
  arrivalId: string;
  receivedAt: Date;
  sourceChain: SourceChain;
  account: ArrivalAccountFields;
  people: ArrivalPerson[];
  signals: ArrivalSignal[];
  facts: ArrivalFact[];
  research: Record<string, unknown>;
  practiceHint?: string;
  soleProprietor: boolean;
  /** Outside ids, for example `{ system: 'hubspot', id: '123' }`. */
  externalIds: { system: string; id: string }[];
};

const ACCOUNT_KEYS = [
  'name', 'domain', 'website_url', 'linkedin_url', 'industry', 'industry_key', 'employees', 'employees_min',
  'employees_max', 'revenue_cents', 'revenue_min_cents', 'revenue_max_cents', 'hq_city', 'hq_state', 'hq_country',
  'description', 'technologies', 'keywords', 'parent_domain', 'headcount_growth_6m', 'founded_year',
];
const PERSON_KEYS = [
  'first_name', 'last_name', 'title', 'seniority', 'email', 'email_status', 'phone', 'mobile_phone', 'linkedin_url',
  'decision_note',
];
const RESEARCH_KEYS = [
  'hook', 'problem', 'pilot', 'price_cents', 'value_hypothesis', 'incumbent', 'caveats', 'contact_route',
  'next_action', 'researcher_score', 'researcher_tier',
];
const MONEY_KEYS = ['contract_value_cents', 'budget_cents'];

/** Fact keys Scout knows. Form answers (`form.<name>`) are known by prefix. */
export const FACT_KEYS: readonly string[] = [...ACCOUNT_KEYS, ...PERSON_KEYS, ...RESEARCH_KEYS, ...MONEY_KEYS];

const KNOWN = new Set(FACT_KEYS);

export function isKnownFactKey(key: string): boolean {
  return KNOWN.has(key) || /^form\..+/.test(key);
}
