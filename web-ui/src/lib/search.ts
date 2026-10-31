/** The non-empty string values of `keys` in a route's search params; anything else is dropped. */
export function pickStrings<K extends string>(search: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const v = search[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}
