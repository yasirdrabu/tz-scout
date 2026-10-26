// Company data: firmographics by domain, plus website text for lead research.

import { intBetween, pick, rng } from "@/lib/rand";
import { modeOf, NotConnectedError, requireEnv } from "../mode";
import { KNOWN_COMPANIES } from "./fixtures";

export type CompanyProfile = {
  domain: string;
  name: string | null;
  employees: number | null;
  revenueCents: number | null;
  industry: string | null;
  hq: string | null;
  description: string | null;
};

export interface CompanyDataAdapter {
  readonly mode: "mock" | "live";
  /** null resolves = could not check. */
  domainResolves(domain: string): Promise<boolean | null>;
  lookup(domain: string): Promise<CompanyProfile>;
  websiteText(domain: string): Promise<string | null>;
}

const INDUSTRIES = ["Commercial real estate", "Property management", "Healthcare services", "Logistics", "Professional services", "Insurance", "Manufacturing", "Financial services", "Legal services", "Retail"];

const mock: CompanyDataAdapter = {
  mode: "mock",
  async domainResolves(domain) {
    if (!domain.includes(".")) return false;
    if (domain.endsWith(".invalid")) return false;
    return true;
  },
  async lookup(domain) {
    const known = KNOWN_COMPANIES[domain];
    if (known) return { domain, ...known };
    const r = rng(`cd:${domain}`);
    const employees = intBetween(r, 40, 2600);
    const name = domain.split(".")[0]!.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
    return {
      domain,
      name,
      employees,
      revenueCents: employees * intBetween(r, 120, 320) * 1000 * 100,
      industry: r() < 0.1 ? null : pick(r, INDUSTRIES),
      hq: pick(r, ["Raleigh, NC", "Charlotte, NC", "Atlanta, GA", "Dallas, TX", "Chicago, IL", "Denver, CO", "Columbus, OH"]),
      description: null,
    };
  },
  async websiteText(domain) {
    const p = await mock.lookup(domain);
    if (!p.name) return null;
    return p.description ?? `${p.name} is a ${p.industry?.toLowerCase() ?? "mid-market"} company headquartered in ${p.hq ?? "the US"} with about ${p.employees ?? "several hundred"} employees.`;
  },
};

const live: CompanyDataAdapter = {
  mode: "live",
  async domainResolves(domain) {
    try {
      const dns = await import("node:dns/promises");
      const r = await dns.resolveAny(domain).catch(() => [] as unknown[]);
      return r.length > 0;
    } catch {
      return null;
    }
  },
  async lookup() {
    requireEnv("companyData", "COMPANY_DATA_API_KEY");
    throw new NotConnectedError("companyData", "pick a firmographics provider before going live");
  },
  async websiteText(domain) {
    try {
      const res = await fetch(`https://${domain}`, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (research bot)" } });
      if (!res.ok) return null;
      const html = await res.text();
      return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
    } catch {
      return null;
    }
  },
};

export function companyDataAdapter(): CompanyDataAdapter {
  return modeOf("companyData") === "live" ? live : mock;
}
