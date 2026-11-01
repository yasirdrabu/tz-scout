import { z } from 'zod';

const text = z.string();
const int = z.number().int();
const list = z.array(z.string());

// Only fields a person or key may set. Names are the fact keys.
const accountFields = {
  name: text,
  domain: text,
  website_url: text,
  linkedin_url: text,
  industry: text,
  industry_key: text,
  employees: int,
  employees_min: int,
  employees_max: int,
  revenue_cents: int,
  revenue_min_cents: int,
  revenue_max_cents: int,
  hq_city: text,
  hq_state: text,
  hq_country: text,
  description: text,
  technologies: list,
  keywords: list,
  parent_domain: text,
  headcount_growth_6m: z.number(),
  founded_year: int,
};

const personFields = {
  first_name: text,
  last_name: text,
  title: text,
  seniority: text,
  email: text,
  phone: text,
  mobile_phone: text,
  linkedin_url: text,
  decision_note: text,
};

const someField = (o: object) => Object.keys(o).length > 0;
const EMPTY = 'Send at least one field to change.';

export const patchAccountBody = z.strictObject(accountFields).partial().refine(someField, EMPTY);
export const patchPersonBody = z
  .strictObject({ ...personFields, role_keys: list })
  .partial()
  .refine(someField, EMPTY);

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** A parsed patch (camelCase keys, as `parseBody` returns it) as facts keyed by the field names the body used. */
export function patchFacts(patch: object, names: 'account' | 'person'): Record<string, unknown> {
  const fields = names === 'account' ? accountFields : personFields;
  const keyOf = Object.fromEntries(Object.keys(fields).map((k) => [camel(k), k]));
  return Object.fromEntries(
    Object.entries(patch)
      .filter(([field, value]) => field in keyOf && value !== undefined)
      .map(([field, value]) => [
        keyOf[field]!,
        (field === 'domain' || field === 'email') && typeof value === 'string' ? value.trim().toLowerCase() : value,
      ]),
  );
}
