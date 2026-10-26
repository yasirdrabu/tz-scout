// Our plain industry words mapped to Apollo's industry names (LinkedIn's taxonomy, lowercase), used
// with organization_industries[] so a pull returns operators in the industry, not anyone whose
// keywords mention it (keyword tags matched magazines, associations and investors).

const MAP: [RegExp, string[]][] = [
  [/real estate|property|proptech|landlord|multifamily/i, ["real estate", "commercial real estate"]],
  [/health|clinic|hospital|medical|care/i, ["hospital & health care", "medical practice", "mental health care", "health, wellness & fitness"]],
  [/logistic|freight|carrier|trucking|supply chain|distribution|transport/i, ["logistics & supply chain", "transportation/trucking/railroad", "package/freight delivery", "warehousing"]],
  [/professional services|consulting|advisory|accounting/i, ["management consulting", "accounting", "professional training & coaching"]],
  [/legal|law/i, ["law practice", "legal services"]],
  [/insurance|mga|underwrit/i, ["insurance"]],
  [/private equity/i, ["venture capital & private equity", "investment management"]],
  [/financial|bank|credit union|lending/i, ["financial services", "banking"]],
  [/manufactur|industrial/i, ["machinery", "industrial automation", "mechanical or industrial engineering", "electrical/electronic manufacturing", "plastics"]],
  [/software|saas|it services/i, ["computer software", "information technology & services"]],
  [/life science|pharma|biotech/i, ["pharmaceuticals", "biotechnology"]],
  [/food|beverage/i, ["food & beverages", "food production"]],
  [/construction|contractor|builder/i, ["construction", "building materials"]],
  [/nonprofit|non-profit/i, ["nonprofit organization management"]],
  [/government/i, ["government administration", "defense & space"]],
  [/franchise|restaurant/i, ["restaurants", "hospitality"]],
];

export function toApolloIndustries(industries: string[]): { mapped: string[]; unmapped: string[] } {
  const mapped = new Set<string>();
  const unmapped: string[] = [];
  for (const i of industries) {
    const hits = MAP.filter(([re]) => re.test(i)).flatMap(([, names]) => names);
    if (hits.length) hits.forEach((h) => mapped.add(h));
    else unmapped.push(i);
  }
  return { mapped: [...mapped], unmapped };
}
