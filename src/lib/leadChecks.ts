// Lead validation checks and the routing decision. Pure: the job gathers the facts, these judge them.

export type CheckResultValue = "PASS" | "FAIL" | "UNKNOWN";
export type CheckOutcome = { check: CheckKey; result: CheckResultValue; reason: string; evidence?: Record<string, unknown> };

export const CHECKS = [
  { key: "work_email", label: "Work email" },
  { key: "company_size", label: "Company size in range" },
  { key: "revenue", label: "Revenue in range" },
  { key: "industry", label: "Industry fits" },
  { key: "role", label: "Role and seniority" },
  { key: "timeline", label: "Timeline in window" },
  { key: "not_existing", label: "Not a customer or open deal" },
] as const;
export type CheckKey = (typeof CHECKS)[number]["key"];

export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com",
  "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com", "zoho.com",
]);

const out = (check: CheckKey, result: CheckResultValue, reason: string, evidence?: Record<string, unknown>): CheckOutcome => ({ check, result, reason, evidence });

export function emailDomain(email: string): string {
  return (email.split("@")[1] ?? "").trim().toLowerCase();
}

export function checkWorkEmail(email: string, domainResolves: boolean | null): CheckOutcome {
  const domain = emailDomain(email);
  if (!domain) return out("work_email", "FAIL", "No email domain.");
  if (FREE_EMAIL_DOMAINS.has(domain)) return out("work_email", "FAIL", `${domain} is a free email provider.`, { domain });
  if (domainResolves === false) return out("work_email", "FAIL", `${domain} does not resolve.`, { domain });
  if (domainResolves == null) return out("work_email", "UNKNOWN", `Could not confirm ${domain} resolves.`, { domain });
  return out("work_email", "PASS", `${domain} is a company domain.`, { domain });
}

export function checkRange(
  check: "company_size" | "revenue",
  value: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
  fmt: (n: number) => string,
): CheckOutcome {
  const noun = check === "company_size" ? "Company size" : "Revenue";
  if (min == null && max == null) return out(check, "PASS", `No ${noun.toLowerCase()} limit on this offering.`);
  if (value == null) return out(check, "UNKNOWN", `${noun} not found.`);
  const range = `${min != null ? fmt(min) : "any"} to ${max != null ? fmt(max) : "any"}`;
  if (min != null && value < min) return out(check, "FAIL", `${noun} ${fmt(value)} is below ${range}.`, { value });
  if (max != null && value > max) return out(check, "FAIL", `${noun} ${fmt(value)} is above ${range}.`, { value });
  return out(check, "PASS", `${noun} ${fmt(value)} is within ${range}.`, { value });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function checkIndustry(
  industry: string | null | undefined,
  domain: string,
  targets: string[],
  excludedCategories: string[],
  excludedDomains: string[],
): CheckOutcome {
  if (excludedDomains.map((d) => d.toLowerCase()).includes(domain.toLowerCase())) return out("industry", "FAIL", `${domain} is on the excluded list.`);
  if (!industry) return out("industry", "UNKNOWN", "Industry not found.");
  const ind = norm(industry);
  const hit = (list: string[]) => list.find((t) => { const n = norm(t); return n && (ind.includes(n) || n.includes(ind)); });
  const excluded = hit(excludedCategories);
  if (excluded) return out("industry", "FAIL", `${industry} is excluded (${excluded}).`, { industry });
  if (targets.length === 0) return out("industry", "PASS", `${industry}; no industry limit on this offering.`, { industry });
  const match = hit(targets);
  if (match) return out("industry", "PASS", `${industry} matches ${match}.`, { industry });
  return out("industry", "FAIL", `${industry} is not a target industry.`, { industry });
}

const SENIOR = ["chief", "ceo", "coo", "cio", "cto", "cfo", "cmo", "ciso", "cdo", "president", "founder", "owner", "partner", "vp", "vice president", "svp", "evp", "head", "director", "principal", "managing"];
const ABBREV: Record<string, string> = { ceo: "chief executive officer", coo: "chief operating officer", cio: "chief information officer", cto: "chief technology officer", cfo: "chief financial officer", ciso: "chief information security officer", cdo: "chief data officer", vp: "vice president" };
const expand = (s: string) => norm(s).split(" ").map((w) => ABBREV[w] ?? w).join(" ");
const FUNCTION_WORDS = new Set(["chief", "officer", "vice", "president", "head", "of", "director", "senior", "the", "and", "svp", "evp", "manager", "lead"]);

/** Seniority must be director level or above, and the function must overlap a target title. */
export function checkRole(title: string | null | undefined, targetTitles: string[]): CheckOutcome {
  if (!title) return out("role", "UNKNOWN", "No job title given.");
  const t = expand(title);
  const senior = SENIOR.some((s) => ` ${t} `.includes(` ${expand(s)} `) || ` ${norm(title)} `.includes(` ${s} `));
  if (!senior) return out("role", "FAIL", `${title} is below director level.`);
  if (targetTitles.length === 0) return out("role", "PASS", `${title} is senior; no title limit.`);
  const words = new Set(t.split(" "));
  for (const target of targetTitles) {
    const e = expand(target);
    if (t.includes(e) || e.includes(t)) return out("role", "PASS", `${title} matches ${target}.`);
    const fn = e.split(" ").filter((w) => !FUNCTION_WORDS.has(w));
    if (fn.length > 0 && fn.some((w) => words.has(w))) return out("role", "PASS", `${title} matches the ${target} function.`);
  }
  // CEO, president, founder and owner can buy anything in the mid-market.
  if (/\b(chief executive officer|president|founder|owner)\b/.test(t.replace(/vice president/g, ""))) return out("role", "PASS", `${title} is a top decision maker.`);
  return out("role", "UNKNOWN", `${title} is senior but not a listed title. Check fit.`);
}

export const TIMELINE_OPTIONS = [
  { value: "now", label: "Now", days: 0 },
  { value: "3m", label: "Within 3 months", days: 90 },
  { value: "6m", label: "3 to 6 months", days: 180 },
  { value: "12m", label: "6 to 12 months", days: 365 },
  { value: "research", label: "Just researching", days: null },
] as const;

export function checkTimeline(answer: string | null | undefined, windowDays: number): CheckOutcome {
  if (!answer) return out("timeline", "UNKNOWN", "No timeline answer.");
  const opt = TIMELINE_OPTIONS.find((o) => o.value === answer || o.label.toLowerCase() === answer.toLowerCase());
  if (!opt) return out("timeline", "UNKNOWN", `Timeline "${answer}" not recognised.`);
  if (opt.days == null) return out("timeline", "FAIL", "Just researching, no timeline.");
  if (opt.days <= windowDays) return out("timeline", "PASS", `${opt.label} is within ${windowDays} days.`);
  return out("timeline", "FAIL", `${opt.label} is beyond the ${windowDays} day window.`);
}

export function checkNotExisting(lookup: { existingCustomer: boolean; openDeal: boolean; detail?: string } | null): CheckOutcome {
  if (!lookup) return out("not_existing", "UNKNOWN", "CRM lookup failed.");
  if (lookup.existingCustomer) return out("not_existing", "FAIL", `Existing customer. ${lookup.detail ?? ""}`.trim());
  if (lookup.openDeal) return out("not_existing", "FAIL", `Open deal already in the CRM. ${lookup.detail ?? ""}`.trim());
  return out("not_existing", "PASS", "No customer record or open deal.");
}

export type Decision = { status: "VALIDATED" | "NOT_QUALIFIED" | "REVIEW"; reason: string };

/** All pass: validated. Any fail: not qualified (nurture). Otherwise any unknown: human review. */
export function decide(checks: { check: string; result: CheckResultValue; reason: string }[]): Decision {
  const fails = checks.filter((c) => c.result === "FAIL");
  if (fails.length > 0) return { status: "NOT_QUALIFIED", reason: fails.map((f) => f.reason).join(" ") };
  const unknown = checks.filter((c) => c.result === "UNKNOWN");
  if (unknown.length > 0) return { status: "REVIEW", reason: unknown.map((u) => u.reason).join(" ") };
  if (checks.length < CHECKS.length) return { status: "REVIEW", reason: "Not every check ran." };
  return { status: "VALIDATED", reason: "Every check passed." };
}
