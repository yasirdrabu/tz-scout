// Money typed into a box and money put back into one. The digits come from the currency, as formatMoney reads them.

const digitsOf = (currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;

/** The currency's own symbol as formatMoney shows it: "$", "€", "£", "CA$". */
const symbolOf = (currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(1).find((p) => p.type === 'currency')?.value ?? '$';

export type DecimalParse = { whole: string; fraction: string } | { error: string };

/**
 * "12.5" or "1,250.5" (en-US grouping) with at most `places` decimals, split at the point, or why not. No signs,
 * exponents or hex: "1e3" and "0x10" are "Enter a number.".
 */
export function parseDecimal(text: string, places: number): DecimalParse {
  const clean = text.replace(/\s/g, '');
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d*)?$/.test(clean)) return { error: 'Enter a number.' };
  const [whole = '', fraction = ''] = clean.replace(/,/g, '').split('.');
  if (fraction.length > places) return { error: places === 0 ? 'Enter a whole amount.' : `Use at most ${places} decimal places.` };
  return { whole, fraction };
}

export type MoneyParse = { cents: number } | { error: string };

/** "12.50", "1,250.50" or "€12" in the currency's units as minor units, or why not. Zero and more are accepted. */
export function parseMoney(text: string, currency: string): MoneyParse {
  const digits = digitsOf(currency);
  const parsed = parseDecimal(text.split(symbolOf(currency)).join('').replace(/\$/g, ''), digits);
  if ('error' in parsed) return parsed;
  const cents = Number(parsed.whole + parsed.fraction.padEnd(digits, '0'));
  return Number.isSafeInteger(cents) ? { cents } : { error: 'Enter a number.' };
}

/** Like `parseMoney`, but null when it is not valid. */
export const parseMoneyInput = (text: string, currency: string): number | null => {
  const r = parseMoney(text, currency);
  return 'cents' in r ? r.cents : null;
};

/** Minor units as typed text: 1250 USD is "12.50", 1000 JPY is "1000". */
export function centsToInput(cents: number, currency: string): string {
  const digits = digitsOf(currency);
  return (cents / 10 ** digits).toFixed(digits);
}
