// When two sources disagree. Only the keys below can conflict; every other key never does,
// including ranges, lists and free text. Tolerances are defaults in code, not settings.

export type Tolerance = { kind: 'count' | 'money' | 'category' | 'contact'; percent?: number };

const TOLERANCES: Record<string, Tolerance> = {
  employees: { kind: 'count', percent: 20 },
  revenue_cents: { kind: 'money', percent: 25 },
  contract_value_cents: { kind: 'money', percent: 10 },
  budget_cents: { kind: 'money', percent: 10 },
  price_cents: { kind: 'money', percent: 10 },
  industry_key: { kind: 'category' },
  hq_country: { kind: 'category' },
  email: { kind: 'contact' },
  phone: { kind: 'contact' },
  mobile_phone: { kind: 'contact' },
  title: { kind: 'contact' },
};

const PHONE_KEYS = ['phone', 'mobile_phone'];

/** The tolerance for a key, or null when the key never conflicts. */
export const toleranceFor = (key: string): Tolerance | null => TOLERANCES[key] ?? null;

const normalise = (key: string, v: unknown) => {
  const s = String(v).trim().toLowerCase();
  return PHONE_KEYS.includes(key) ? s.replace(/\D/g, '') : s;
};

/** True when the two values disagree beyond the key's tolerance. */
export const differs = (key: string, a: unknown, b: unknown): boolean => {
  const tol = toleranceFor(key);
  if (!tol) return false;
  if (tol.kind === 'count' || tol.kind === 'money') {
    if (typeof a !== 'number' || typeof b !== 'number') return false;
    const larger = Math.max(Math.abs(a), Math.abs(b));
    if (larger === 0) return false;
    return (Math.abs(a - b) / larger) * 100 > tol.percent!;
  }
  if (a == null || b == null) return false;
  return normalise(key, a) !== normalise(key, b);
};
