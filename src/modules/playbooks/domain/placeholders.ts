// Placeholders in template text (Ruling 8): `{account.name}`, `{offer.name}`, `{offer.promise}`, `{seller.first_name}`
// and `{person.first_name}`. Templates store the raw text; it is rendered when a plan is built.

/** Values by placeholder name, e.g. `'account.name'`. A missing or null value leaves the placeholder as written. */
export type PlaceholderVars = Record<string, string | null | undefined>;

/** Where the text goes: an email says "there", everything else says "the contact". */
export type RenderContext = 'email' | 'detail';

const PLACEHOLDER = /\{([a-z_]+\.[a-z_]+)\}/g;
const PERSON_FALLBACK: Record<RenderContext, string> = { email: 'there', detail: 'the contact' };

/**
 * Fills the placeholders in `text`. An unknown placeholder, or a known one without a value, is kept as written so the
 * seller sees it. `person.first_name` with no one linked becomes "there" in an email and "the contact" elsewhere.
 * Values are inserted as is; they are never expanded again.
 */
export function render(text: string, vars: PlaceholderVars, context: RenderContext): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    if (value) return value;
    return name === 'person.first_name' ? PERSON_FALLBACK[context] : whole;
  });
}
