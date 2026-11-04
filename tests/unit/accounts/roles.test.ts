import { describe, expect, it } from 'vitest';
import { guessRolesFromTitle } from '@/modules/accounts/domain/roles';

const cases: [string | null, string[]][] = [
  ['Chief of Paratransit Operations & Mobility Services', ['business_owner']],
  ['Contracts Manager', ['procurement']],
  ['CFO', ['commercial_buyer']],
  ['VP, Information Technology', ['technical_buyer']],
  ['Director of Purchasing', ['procurement']],
  ['Head of Data & Security', ['technical_buyer']],
  ['Marketing Coordinator', []],
  [null, []],
  ['Datapoint Analyst', []],
  ['CTO', ['technical_buyer']],
  ['Head of IT', ['technical_buyer']],
  ['Digital Marketing', []],
  ['Owner', ['commercial_buyer']],
  ['President & CEO', ['commercial_buyer']],
  ['Chief Executive Officer', ['commercial_buyer']],
  ['Finance Director', ['commercial_buyer']],
  ['Vice President of Operations', ['business_owner']],
  ['Vice-President of Operations', ['business_owner']],
  ['Vice  President of Sales', ['business_owner']],
  ['Director of Operations', ['business_owner']],
  ['Senior Buyer, Infrastructure', ['technical_buyer', 'procurement']],
  ['Sourcing Director', ['procurement']],
  ['', []],
];

describe('guessRolesFromTitle', () => {
  it.each(cases)('%s', (title, expected) => {
    expect(guessRolesFromTitle(title)).toEqual(expected);
  });
});
