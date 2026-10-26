// A row from a Vibe Prospecting dataset export (get-dataset, load_into "context") to a VibeCompany.
// Vibe stores lists and events as JSON strings; ranges come wrapped in brackets ("[201-500]").

import type { VibeCompany } from "./vibe";

export type VibeExportRow = Record<string, string | null | undefined>;

type RawEvent = Record<string, unknown> & { event_name: string; event_time: string };

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const unwrap = (s: string | null | undefined) => (s ? s.replace(/^\[|\]$/g, "").trim() || null : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
const cap = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase());

const clip = (s: string, n = 140) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(" ", n))}...`);

/** "The Fortegra Group, Inc." -> "fortegra": for checking a news item is about this company. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[®™.,()&]/g, " ").replace(/\b(the|inc|llc|ltd|co|corp|corporation|company|companies|group|holdings|sdn bhd)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Vibe attaches M&A coverage by name match, so plenty of it is about someone else. Keep it only when this company is a party. */
export function isParty(company: string, involved: unknown): boolean {
  if (!Array.isArray(involved)) return false;
  const key = nameKey(company);
  return !!key && involved.some((c) => typeof c === "string" && nameKey(c).startsWith(key));
}

/** Title and detail for one raw Vibe event, in our words. mapEvent then decides the signal type. */
function describe(e: RawEvent, company: string): { title: string | null; detail: string | null; url: string | null } {
  const url = str(e.link);
  switch (e.event_name) {
    case "employee_joined_company": {
      const who = [str(e.full_name), str(e.job_department)].filter(Boolean).join(", ");
      return { title: str(e.job_role_title), detail: who || null, url: str(e.linkedin_url) ? `https://${String(e.linkedin_url).replace(/^https?:\/\//, "")}` : null };
    }
    case "merger_and_acquisitions": {
      const headline = str(e.title);
      const first = company.split(" ")[0]!.toLowerCase();
      const title = headline && headline.toLowerCase().includes(first) ? headline : str(e.description) ? clip(String(e.description)) : headline;
      return { title, detail: str(e.description) ?? str(e.snippet), url };
    }
    case "new_office":
      return { title: str(e.title), detail: [str(e.purpose_of_new_office), str(e.office_location)].filter(Boolean).join(". ") || str(e.snippet), url };
    case "lawsuits_and_legal_issues":
      return { title: str(e.title), detail: [str(e.case_type), str(e.court)].filter(Boolean).join(", ") || null, url };
    case "new_funding_round": {
      const t = [str(e.investment_amount_string) && `Raised ${e.investment_amount_string}`, str(e.funding_stage)].filter(Boolean).join(", ");
      return { title: t || str(e.title), detail: str(e.lead_investor) ? `Led by ${e.lead_investor}.` : str(e.snippet), url };
    }
    case "outages_and_security_breaches": {
      const n = typeof e.number_of_affected_customers === "number" ? e.number_of_affected_customers : null;
      const t = [str(e.incident_type) && cap(String(e.incident_type)), n ? `${n.toLocaleString("en-US")} people affected` : null].filter(Boolean).join(", ");
      return { title: t || str(e.title), detail: str(e.snippet), url };
    }
    default:
      if (e.event_name.startsWith("hiring_in_")) {
        const titles = Array.isArray(e.job_titles) ? (e.job_titles as string[]).slice(0, 3).join(", ") : null;
        const n = typeof e.job_count === "number" ? e.job_count : null;
        return { title: titles, detail: [n ? `${n} open role${n === 1 ? "" : "s"}` : null, str(e.location)].filter(Boolean).join(", ") || null, url };
      }
      if (e.event_name.startsWith("increase_in_") || e.event_name.startsWith("decrease_in_")) {
        const n = typeof e.department_change === "number" ? e.department_change : null;
        return { title: null, detail: n != null ? `Department headcount changed ${n > 0 ? "+" : ""}${n}% this period.` : null, url };
      }
      return { title: str(e.title), detail: str(e.snippet) ?? str(e.description), url };
  }
}

/** Events older than this are history, not a reason to call now. */
export const EVENT_WINDOW_DAYS = 365;
/** News-type events kept per type, most recent first. Hires and new leaders are kept in full. */
const NEWS_PER_TYPE = 3;
const CRIME = /\b(murder|homicide|assault|robbery|shooting|stabbing|manslaughter|theft|burglary|criminal)\b/i;

export function fromVibeExportRow(r: VibeExportRow, now: Date): VibeCompany {
  const cutoff = now.getTime() - EVENT_WINDOW_DAYS * 86400_000;
  const events: NonNullable<VibeCompany["events"]> = [];
  const company = r.business_name ?? "";
  for (const [k, v] of Object.entries(r)) {
    if (!k.startsWith("event_")) continue;
    const list = json<RawEvent[]>(v, [])
      .filter((e) => {
        const t = new Date(e.event_time).getTime();
        if (Number.isNaN(t) || t < cutoff) return false;
        if (e.event_name === "merger_and_acquisitions") return isParty(company, e.companies_involved);
        // Crime stories land on the hospital the victim went to. Not the company's legal exposure.
        if (e.event_name === "lawsuits_and_legal_issues") return !CRIME.test(String(e.case_type ?? ""));
        return true;
      })
      .sort((a, b) => b.event_time.localeCompare(a.event_time));
    const keepAll = /^(employee_joined_company|hiring_in_)/.test(k.replace(/^event_/, ""));
    for (const e of keepAll ? list : list.slice(0, NEWS_PER_TYPE)) {
      const at = new Date(e.event_time);
      const d = describe(e, company);
      const date = at.toISOString().slice(0, 10);
      events.push({ type: e.event_name, date, title: d.title, detail: d.detail, url: d.url, id: `${e.event_name}:${date}:${slug(d.title ?? d.detail ?? "")}` });
    }
  }

  const share: Record<string, number> = {};
  const change: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) {
    const n = v == null || v === "" ? NaN : Number(v);
    if (Number.isNaN(n)) continue;
    const p = k.match(/^work_trend_perc_(.+)_roles$/);
    if (p) share[p[1]!.replace(/_/g, " ")] = n / 100;
    const c = k.match(/^work_trend_change_in_(.+)_roles$/);
    if (c) change[c[1]!.replace(/_/g, " ")] = n;
  }

  return {
    businessId: r.business_id ?? r.business_domain ?? "",
    name: r.business_name ?? r.business_domain ?? "",
    domain: (r.business_domain ?? "").toLowerCase(),
    website: r.business_website ?? null,
    linkedin: r.business_linkedin_profile ?? null,
    city: r.business_city_name ?? null,
    region: r.business_region ?? null,
    country: r.business_country_name ?? null,
    naics: r.business_naics ?? null,
    naicsDescription: r.business_naics_description ?? null,
    linkedinCategory: r.business_linkedin_industry_category ?? null,
    employeesRange: unwrap(r.business_number_of_employees_range),
    revenueRange: unwrap(r.business_yearly_revenue_range),
    description: r.business_business_description ?? null,
    techStack: json<string[]>(r.tech_full_tech_stack, []),
    intent: json<{ topic: string; score: number }[]>(r.business_business_intent_topics, []),
    workforce: Object.keys(share).length || Object.keys(change).length ? { share, change, quarter: r.work_trend_quarters ?? null } : undefined,
    events,
  };
}

// ---------- People ----------

export type VibePerson = { prospectId: string; businessId: string; firstName: string; lastName: string | null; title: string | null; email: string | null; emailStatus: string | null; phone: string | null; linkedin: string | null };

/** A row from a Vibe prospects export (with contact enrichment) to one person. */
export function fromVibeProspectRow(r: VibeExportRow): VibePerson | null {
  if (!r.prospect_id || !r.business_id) return null;
  // Vibe sometimes splits "Ed Romito, Chcio, Cdh-e" into first "Romito", last "Romito, Chcio, ...".
  // When the parts look wrong, read the name from the full name, dropping credentials after the comma.
  let first = (r.prospect_first_name ?? "").trim();
  let last = (r.prospect_last_name ?? "").trim();
  const full = (r.prospect_full_name ?? "").split(",")[0]!.trim();
  if (full && (!first || last.includes(",") || !full.toLowerCase().startsWith(first.toLowerCase()))) {
    const parts = full.split(/\s+/);
    first = parts[0] ?? first;
    last = parts.slice(1).join(" ");
  }
  if (!first) return null;
  const li = r.prospect_linkedin?.trim();
  return {
    prospectId: r.prospect_id,
    businessId: r.business_id,
    firstName: first,
    lastName: last || null,
    title: r.prospect_job_title ? r.prospect_job_title.replace(/^\w/, (c) => c.toUpperCase()) : null,
    email: r.contact_professional_email?.trim().toLowerCase() || null,
    emailStatus: r.contact_professional_email_status?.trim() || null,
    phone: r.contact_mobile_phone?.trim() || null,
    linkedin: li ? (li.startsWith("http") ? li : `https://${li}`) : null,
  };
}

/** Seniority from a title, for picking who to approach first. */
export function seniority(title: string | null): number {
  const t = (title ?? "").toLowerCase();
  if (/\b(chief|ceo|coo|cio|cto|cfo|ciso|cdo|cmo)\b/.test(t)) return 40;
  if (/\bpresident\b/.test(t) && !/\bvice\b/.test(t)) return 35;
  if (/\b(svp|evp|vp|vice president)\b/.test(t)) return 30;
  if (/\bhead of\b|\bhead\b/.test(t)) return 25;
  if (/\bdirector\b/.test(t)) return 20;
  return 10;
}
