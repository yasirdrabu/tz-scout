import { KINDS, type EnrichmentKind } from '../contracts/types';
import { OPERATIONS } from './prices';

export { KINDS };

const LABELS: Record<EnrichmentKind, string> = {
  company_firmographics: 'Company facts',
  people_for_roles: 'People for buying roles',
  email_reveal: 'Reveal emails',
  website_read: 'Read the website',
  signals_refresh: 'Fresh signals',
};

export const kindLabel = (kind: EnrichmentKind): string => LABELS[kind];

/** The provider operations a kind runs, in order; empty when the provider does not do that kind. */
export const operationsFor = (provider: string, kind: EnrichmentKind): readonly string[] => OPERATIONS[provider]?.[kind] ?? [];
