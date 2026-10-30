import type { ModuleContext } from '@/platform/context';

/** The shared provider list (spec: integrations/adapter-contract-and-providers.md). */
export type Provider = {
  key: string;
  name: string;
  usedFor: string;
  interfaceOwner: string;
  release: 'R0' | 'R1' | 'R2' | 'R4';
};

export const PROVIDERS: readonly Provider[] = [
  { key: 'hubspot', name: 'HubSpot', usedFor: 'Keeps contacts, companies and deals in your CRM', interfaceOwner: 'crm-sync', release: 'R1' },
  { key: 'apollo', name: 'Apollo', usedFor: 'Finds people and companies to contact', interfaceOwner: 'enrichment', release: 'R1' },
  { key: 'vibe', name: 'Vibe Prospecting', usedFor: 'Finds more details about leads', interfaceOwner: 'enrichment', release: 'R1' },
  { key: 'anthropic', name: 'Claude (Anthropic)', usedFor: 'Scores and researches leads', interfaceOwner: 'ai-tasks', release: 'R1' },
  { key: 'microsoft', name: 'Microsoft Entra ID', usedFor: 'Signs your team in with Microsoft', interfaceOwner: 'tenancy-and-access', release: 'R0' },
  { key: 'email', name: 'Email sending', usedFor: 'Sends notices and campaign emails', interfaceOwner: 'platform', release: 'R1' },
  { key: 'salesforce', name: 'Salesforce', usedFor: 'Keeps contacts, companies and deals in your CRM', interfaceOwner: 'crm-sync', release: 'R4' },
  { key: 'dynamics', name: 'Microsoft Dynamics 365', usedFor: 'Keeps contacts, companies and deals in your CRM', interfaceOwner: 'crm-sync', release: 'R4' },
  { key: 'dayko_kindle', name: 'Dayko Kindle', usedFor: 'Keeps contacts, companies and deals in your CRM', interfaceOwner: 'crm-sync', release: 'R4' },
  { key: 'meta', name: 'Meta ads', usedFor: 'Reads ad spend and results', interfaceOwner: 'campaigns', release: 'R4' },
  { key: 'linkedin', name: 'LinkedIn ads', usedFor: 'Reads ad spend and results', interfaceOwner: 'campaigns', release: 'R4' },
  { key: 'google_ads', name: 'Google Ads', usedFor: 'Reads ad spend and results', interfaceOwner: 'campaigns', release: 'R4' },
  { key: 'booking', name: 'Booking', usedFor: 'Tracks booked meetings', interfaceOwner: 'campaigns', release: 'R4' },
  { key: 'sms', name: 'SMS', usedFor: 'Sends text messages', interfaceOwner: 'campaigns', release: 'R4' },
  { key: 'company_data', name: 'Company data', usedFor: 'Adds company details to leads', interfaceOwner: 'enrichment', release: 'R2' },
];

/** Test-only provider that backs the integration tests. Never listed to users. */
export const DEMO_PROVIDER = 'demo';

export const isKnownProvider = (key: string): boolean => key === DEMO_PROVIDER || PROVIDERS.some((p) => p.key === key);
export const providerName = (key: string): string => PROVIDERS.find((p) => p.key === key)?.name ?? key;

/** `facts` are non-secret details a passing test learned (HubSpot: `portal_id`, `portal_name`); they are merged into `connection.settings`. */
export type TestResult = { ok: boolean; message: string; missingPermissions?: string[]; facts?: Record<string, string> };

/** Every adapter can test itself. Provider-specific methods are typed by the module that owns the capability. */
export type Adapter = { test(): Promise<TestResult> };

/** What a live adapter is built from. Decrypted values exist only while `gateway.call` runs. */
export type LiveCredentials = { kind: string; value: string; settings: Record<string, unknown> };

export type AdapterFactories = {
  mock: (ctx: ModuleContext) => Adapter;
  live?: (creds: LiveCredentials) => Adapter;
};

const adapters = new Map<string, AdapterFactories>();

export function registerAdapter(provider: string, factories: AdapterFactories): void {
  adapters.set(provider, factories);
}

export const adapterFactories = (provider: string): AdapterFactories | undefined => adapters.get(provider);
