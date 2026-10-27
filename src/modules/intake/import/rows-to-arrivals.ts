import type { ArrivalV1 } from '../contracts/arrival';
import { domainFromEmail, normaliseDomain, parseRange } from '../domain/normalise';
import { defined } from '../domain/normalise-arrival';
import type { ParsedFile } from './parse';
import type { MappingOutput } from './synonyms';
import type { ArrivalDraft } from './layouts';

// SRC-E4: rows and a column mapping to one arrival per company, with all its people. Ported from v1 `groupRows`.

export type SkippedRow = { row: number; reason: string };

type Person = ArrivalV1['people'][number];
type Signal = NonNullable<ArrivalV1['signals']>[number];
type Account = NonNullable<ArrivalV1['account']>;

const ACCOUNT_TEXT = ['name', 'website', 'domain', 'linkedin_url', 'country', 'region', 'city', 'industry', 'notes', 'practice_hint', 'external_ref'] as const;
type PersonField = 'name' | 'first_name' | 'last_name' | 'email' | 'title' | 'phone' | 'linkedin_url';
const RESEARCH_TEXT = ['hook', 'problem', 'pilot', 'value_hypothesis', 'incumbent', 'caveats', 'contact_route', 'next_action', 'researcher_tier'] as const;
const RESEARCH_NUMBERS = ['price_cents', 'researcher_score'] as const;
const KINDS = ['research', 'trigger', 'pain'] as const;

type RowFacts = {
  account: Partial<Record<(typeof ACCOUNT_TEXT)[number], string>> & { employees?: string };
  custom: Record<string, string>;
  /** People by their group number, so a gap (`people[2]` with no `people[1]`) is just a missing key. */
  people: Map<number, Partial<Record<PersonField, string>>>;
  signals: Signal[];
  research: Record<string, string | number>;
};

/** `2026-10-22`, `2026-10-22T09:00:00Z` and US `10/22/2026` as a date. Anything else is no date. */
function isoDate(text: string): string | undefined {
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/);
  if (iso) return iso[1];
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  return undefined;
}

function signalFrom(parts: { title?: string; occurred_at?: string; url?: string; type?: string }): Signal | null {
  if (!parts.title) return null;
  const kind = parts.type?.toLowerCase();
  const asKind = KINDS.find((k) => k === kind);
  const fine = !asKind && kind ? kind.replace(/[^a-z0-9]+/g, '_') : undefined;
  return defined({
    type: asKind ?? (fine ? undefined : 'research'),
    fine_type: fine,
    title: parts.title,
    occurred_at: parts.occurred_at ? isoDate(parts.occurred_at) : undefined,
    url: parts.url,
  }) as Signal;
}

function readRow(row: string[], targets: (string | null)[]): RowFacts {
  const f: RowFacts = { account: {}, custom: {}, people: new Map(), signals: [], research: {} };
  // Signal columns in file order: each title starts a signal, and the date, link and type columns beside it join it.
  const signalParts: { title?: string; occurred_at?: string; url?: string; type?: string }[] = [];
  let pending: (typeof signalParts)[number] = {};
  targets.forEach((target, i) => {
    const value = (row[i] ?? '').trim();
    if (!target || !value) return;
    const person = target.match(/^people\[(\d+)\]\.(\w+)$/);
    const sig = target.match(/^signals\[\]\.(\w+)$/);
    const res = target.match(/^research\.(\w+)$/);
    if (person) {
      const n = Number(person[1]);
      f.people.set(n, { ...f.people.get(n), [person[2]!]: value });
    } else if (sig) {
      const field = sig[1] as 'title' | 'occurred_at' | 'url' | 'type';
      if (field === 'title') {
        signalParts.push({ ...pending, title: value });
        pending = {};
      } else if (signalParts.length && signalParts[signalParts.length - 1]![field] === undefined) signalParts[signalParts.length - 1]![field] = value;
      else pending[field] = value;
    } else if (res) {
      if ((RESEARCH_TEXT as readonly string[]).includes(res[1]!)) f.research[res[1]!] = value;
      else if ((RESEARCH_NUMBERS as readonly string[]).includes(res[1]!)) {
        const n = Number(value.replace(/[^\d.]/g, ''));
        if (value && Number.isFinite(n)) f.research[res[1]!] = n;
      }
    } else if (target.startsWith('account.custom_fields.')) f.custom[target.slice('account.custom_fields.'.length)] = value;
    else if (target === 'account.employees') f.account.employees = value;
    else if (target.startsWith('account.')) f.account[target.slice('account.'.length) as (typeof ACCOUNT_TEXT)[number]] = value;
  });
  for (const p of signalParts) {
    const s = signalFrom(p);
    if (s) f.signals.push(s);
  }
  return f;
}

function personFrom(p: Partial<Record<PersonField, string>>): Person | null {
  const email = p.email?.includes('@') ? p.email.toLowerCase() : undefined;
  const out = defined({
    // v1 dropped credentials after a comma ("Ed Romito, CPA").
    name: p.name?.split(',')[0]!.trim() || undefined,
    first_name: p.first_name,
    last_name: p.last_name,
    title: p.title,
    email,
    phone: p.phone,
    linkedin_url: p.linkedin_url,
  }) as Person;
  return Object.keys(out).length ? out : null;
}

const personKey = (p: Person) => p.email ?? (p.name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`).trim().toLowerCase();

type Company = {
  account: Partial<Record<(typeof ACCOUNT_TEXT)[number], string>>;
  employees: Pick<Account, 'employees' | 'employees_range'>;
  notes: string[];
  custom: Record<string, string>;
  people: Person[];
  signals: Signal[];
  research: Record<string, string | number>;
  rows: string[][];
};

function employeesOf(text: string | undefined): Pick<Account, 'employees' | 'employees_range'> {
  if (!text) return {};
  if (parseRange(text)) return { employees_range: text };
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? { employees: Math.round(n) } : {};
}

/**
 * Rows to one arrival per company, grouped by the website's domain, else the work-email domain. A company with
 * a name and no website is kept (it waits for one). A row with no company is skipped, with its row number.
 */
export function rowsToArrivals(
  parsed: ParsedFile,
  mapping: MappingOutput,
  _opts: { fileName: string },
): { arrivals: { body: ArrivalV1; raw: ArrivalDraft['raw'] }[]; skipped: SkippedRow[] } {
  const byHeader = new Map(mapping.columns.map((c) => [c.header, c.target]));
  const targets = parsed.headers.map((h) => byHeader.get(h) ?? null);
  const groups = new Map<string, Company>();
  const skipped: SkippedRow[] = [];

  parsed.rows.forEach((row, i) => {
    const f = readRow(row, targets);
    const people = [...f.people.entries()].sort(([a], [b]) => a - b).map(([, p]) => personFrom(p)).filter((p): p is Person => p !== null);
    const emails = people.map((p) => p.email).filter((e): e is string => !!e);
    const domain =
      normaliseDomain(f.account.website) ?? normaliseDomain(f.account.domain) ?? emails.map((e) => normaliseDomain(domainFromEmail(e))).find(Boolean) ?? null;
    const name = f.account.name;
    if (!domain && !name) {
      skipped.push({ row: parsed.rowNumbers[i]!, reason: emails.length ? 'Personal email and no company' : 'No company, website or work email' });
      return;
    }
    const key = domain ?? `name:${name!.toLowerCase()}`;
    const c: Company =
      groups.get(key) ?? { account: {}, employees: {}, notes: [], custom: {}, people: [], signals: [], research: {}, rows: [] };
    c.rows.push(row);
    for (const k of ACCOUNT_TEXT) if (k !== 'notes') c.account[k] ??= f.account[k];
    if (f.account.notes) c.notes.push(f.account.notes);
    if (c.employees.employees === undefined && c.employees.employees_range === undefined) c.employees = employeesOf(f.account.employees);
    for (const [k, v] of Object.entries(f.custom)) c.custom[k] ??= v;
    for (const [k, v] of Object.entries(f.research)) c.research[k] ??= v;
    for (const p of people) if (!c.people.some((x) => personKey(x) === personKey(p))) c.people.push(p);
    for (const s of f.signals) if (!c.signals.some((x) => x.title === s.title && x.occurred_at === s.occurred_at)) c.signals.push(s);
    groups.set(key, c);
  });

  const arrivals = [...groups.values()].map((c) => {
    const account = defined({
      ...c.account,
      ...c.employees,
      notes: c.notes.length ? c.notes.join('\n') : undefined,
      custom_fields: Object.keys(c.custom).length ? c.custom : undefined,
    }) as Account;
    const body: ArrivalV1 = {
      account,
      people: c.people,
      signals: c.signals,
      facts: {},
      research: Object.keys(c.research).length ? c.research : undefined,
      sole_proprietor: false,
    };
    return { body, raw: { headers: parsed.headers, rows: c.rows } };
  });
  return { arrivals, skipped };
}
