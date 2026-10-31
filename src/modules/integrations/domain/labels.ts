/** What each credential kind is called on screen (screens.md §21b). */
export const CREDENTIAL_LABELS: Record<string, string> = {
  api_key: 'Key',
  private_app_token: 'Private app token',
  oauth_tokens: 'Sign-in tokens',
  client_secret: 'Client secret',
};

/** The Integrations screen's group for a provider, from the module that owns its interface. */
const GROUPS: Record<string, string> = {
  'crm-sync': 'CRM',
  enrichment: 'Data and enrichment',
  'ai-tasks': 'AI',
  platform: 'Email and messages',
  campaigns: 'Campaigns',
  'tenancy-and-access': 'Sign-in',
};

export const providerGroup = (interfaceOwner: string): string => GROUPS[interfaceOwner] ?? 'Other';
