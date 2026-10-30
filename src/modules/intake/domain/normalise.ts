import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json';
import { parse } from 'tldts';
import { isFreeEmailDomain } from './free-email';

countries.registerLocale(en);

/**
 * The registrable domain of a domain, URL or host, in the form accounts stores it (lowercase,
 * no `www.`, no path or port). Null for an email, an IP address, a free mail provider or anything
 * that is not a real public domain. The reserved `.example` names (RFC 2606) count, so the sample CRM's
 * companies (`qualified.example`) come in through intake on a laptop.
 */
export function normaliseDomain(input: string | null | undefined): string | null {
  const text = input?.trim();
  if (!text || /\s/.test(text) || /^mailto:/i.test(text) || text.includes('@')) return null;
  const r = parse(text);
  const sample = r.publicSuffix?.toLowerCase() === 'example';
  if (r.isIp || !(r.isIcann || sample) || !r.domain) return null;
  const domain = r.domain.toLowerCase();
  return isFreeEmailDomain(domain) ? null : domain;
}

/** The part after the `@`, lowercase. Null when there is none. */
export function domainFromEmail(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  if (!email || at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}

/** ISO 3166 alpha-2 from a name (`United States`), alpha-2 or alpha-3 code (`us`, `USA`). Null if unknown. */
export function countryCode(input: string | null | undefined): string | null {
  const text = input?.trim();
  if (!text) return null;
  if (text.toUpperCase() === 'UK') return 'GB';
  if (text.length === 2) return countries.isValid(text.toUpperCase()) ? text.toUpperCase() : null;
  if (text.length === 3) return countries.toAlpha2(text.toUpperCase()) ?? countries.getAlpha2Code(text, 'en') ?? null;
  return countries.getAlpha2Code(text, 'en') ?? null;
}

const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

function amount(text: string): number | null {
  const m = /^\$?\s*(\d+(?:\.\d+)?)\s*([kmb])?$/i.exec(text.replace(/,/g, '').trim());
  return m ? Math.round(Number(m[1]) * (m[2] ? SCALE[m[2].toLowerCase()]! : 1)) : null;
}

/** `501-1000`, `10001+`, `75M-200M` or `[201-500]` as a min and max. A missing end is null. */
export function parseRange(input: string | null | undefined): { min: number | null; max: number | null } | null {
  const text = input?.trim().replace(/^\[(.*)\]$/, '$1').trim();
  if (!text) return null;
  if (text.endsWith('+')) {
    const min = amount(text.slice(0, -1));
    return min === null ? null : { min, max: null };
  }
  const parts = text.split(/\s*[-–]\s*/);
  if (parts.length !== 2) return null;
  const [min, max] = [amount(parts[0]!), amount(parts[1]!)];
  return min === null || max === null ? null : { min, max };
}
