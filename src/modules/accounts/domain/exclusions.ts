// Exclusion rules (ACC-E7). The first enabled rule that matches, in this order, sets the reason.

import type { CrmStatus } from '../contracts/types';

export type ExclusionInput = {
  industryKey: string | null;
  description: string | null;
  keywords: string[];
  name: string;
  parentDomain: string | null;
  parentName: string | null;
  domain: string | null;
  crmStatus: CrmStatus;
};

export type ExclusionRuleState = { key: string; enabled: boolean };
export type ExclusionListRow = { kind: string; value: string };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Returns the key of the first enabled rule that matches, or null. */
export function evaluateExclusions(
  input: ExclusionInput,
  rules: ExclusionRuleState[],
  lists: ExclusionListRow[],
): string | null {
  const values = (kind: string) => lists.filter((l) => l.kind === kind).map((l) => l.value.trim().toLowerCase());
  const enabled = new Set(rules.filter((r) => r.enabled).map((r) => r.key));

  const checks: [string, () => boolean][] = [
    [
      'software_vendor',
      () => {
        if (input.industryKey === 'software') return true;
        const text = [input.description ?? '', ...input.keywords].join('\n').toLowerCase();
        return values('vendor_keyword').some((p) => p && new RegExp(`\\b${escape(p)}\\b`).test(text));
      },
    ],
    [
      'unit_of_parent',
      () =>
        (!!input.parentDomain && values('parent_domain').includes(input.parentDomain.trim().toLowerCase())) ||
        !!input.parentName?.trim(),
    ],
    ['existing_customer', () => input.crmStatus === 'customer'],
    ['open_deal', () => input.crmStatus === 'open_deal'],
    ['domain_listed', () => !!input.domain && values('do_not_contact_domain').includes(input.domain.trim().toLowerCase())],
  ];
  return checks.find(([key, test]) => enabled.has(key) && test())?.[0] ?? null;
}
