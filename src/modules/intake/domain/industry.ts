/** NAICS prefix to industry key (from the v1 Vibe mapping). The longest matching prefix wins. */
const NAICS: [string, string][] = [
  ['5112', 'software'], ['5132', 'software'], ['5182', 'software'], ['54151', 'software'],
  ['5311', 'commercial_real_estate'], ['5313', 'property_management'], ['531', 'real_estate'],
  ['524', 'insurance'], ['52', 'financial_services'],
  ['62', 'healthcare_services'],
  ['48', 'logistics'], ['49', 'logistics'],
  ['31', 'manufacturing'], ['32', 'manufacturing'], ['33', 'manufacturing'], ['42', 'distribution'],
  ['5411', 'legal_services'], ['54', 'professional_services'], ['23', 'construction'], ['92', 'government_services'],
];

/** Phrases (lowercase) to industry key, checked in order, so specific phrases come first. */
const WORDS: [string, string][] = [
  ['commercial real estate', 'commercial_real_estate'],
  ['property management', 'property_management'],
  ['real estate', 'real_estate'],
  ['private equity', 'private_equity'],
  ['insurance', 'insurance'],
  ['financial services', 'financial_services'],
  ['banking', 'financial_services'],
  ['life sciences', 'life_sciences'],
  ['biotech', 'life_sciences'],
  ['pharma', 'life_sciences'],
  ['pharmaceuticals', 'life_sciences'],
  ['biotechnology', 'life_sciences'],
  ['healthcare', 'healthcare_services'],
  ['hospital', 'healthcare_services'],
  ['hospitals', 'healthcare_services'],
  ['legal', 'legal_services'],
  ['it services', 'it_services'],
  ['information technology', 'it_services'],
  ['it consulting', 'it_services'],
  ['software', 'software'],
  ['saas', 'software'],
  ['logistics', 'logistics'],
  ['freight', 'logistics'],
  ['trucking', 'logistics'],
  ['warehousing', 'logistics'],
  ['transportation', 'transportation'],
  ['transit', 'transportation'],
  ['manufacturing', 'manufacturing'],
  ['distribution', 'distribution'],
  ['wholesale', 'distribution'],
  ['food and beverage', 'food_and_beverage'],
  ['nonprofit', 'nonprofit'],
  ['non profit', 'nonprofit'],
  ['construction', 'construction'],
  ['government', 'government_services'],
  ['professional services', 'professional_services'],
  ['consulting', 'professional_services'],
];

/** An industry key from a NAICS code or free text. Null when no rule matches (the AI task is the next step). */
export function industryKey(text: string | null | undefined): string | null {
  const t = text?.trim().toLowerCase();
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const hit = NAICS.filter(([p]) => t.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
    return hit ? hit[1] : null;
  }
  const flat = ` ${t.replace(/[^a-z0-9]+/g, ' ').trim()} `;
  return WORDS.find(([phrase]) => flat.includes(` ${phrase} `))?.[1] ?? null;
}
