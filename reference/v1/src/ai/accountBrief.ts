// AI task for Buyers: why now, the angle, an opener, and who to contact for one account and offer.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/accountBrief.v1";

export const AccountBriefSchema = z.object({ whyNow: z.string(), angle: z.string(), opener: z.string(), contactTitle: z.string() });
export type AccountBrief = z.infer<typeof AccountBriefSchema>;
export type AccountBriefInput = Parameters<typeof P.user>[0];

const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");

/** A signal as a phrase that follows the company name: "is hiring a Director of AI". */
export function signalPhrase(company: string, s: { type: string; title: string }): string {
  const t = s.title.trim();
  if (s.type === "intent") return `is actively researching ${t.replace(/^Researching:\s*/i, "")}`;
  if (s.type === "hiring") {
    const m = t.match(/^Hiring(?: in ([\w &]+))?:\s*(.+)$/i);
    if (!m) return t.toLowerCase().startsWith("hiring") ? `is ${t.replace(/^Hiring/i, "hiring")}` : `is hiring ${article(t)} ${t}`;
    const role = m[2]!.split(",")[0]!.trim();
    return `is hiring ${article(role)} ${role}${m[1] ? ` in ${m[1].toLowerCase()}` : ""}`;
  }
  if (s.type === "leadership" && /^New leader joined:\s*/i.test(t)) {
    const role = t.replace(/^New leader joined:\s*/i, "");
    return `just brought on a new ${role}`;
  }
  if (s.type === "workforce") {
    const share = t.match(/^(\w[\w ]*) is (\d+)% of staff/i);
    if (share) return `has ${share[2]}% of its staff in ${share[1]!.toLowerCase()}`;
    const growing = t.match(/^(\w[\w ]*) team growing/i);
    if (growing) return `is growing its ${growing[1]!.toLowerCase()} team`;
    if (/every department/i.test(t)) return "is hiring across every department";
  }
  if (s.type === "risk") {
    if (/^Lawsuit:\s*/i.test(t)) return `is dealing with a legal issue: "${t.replace(/^Lawsuit:\s*/i, "")}"`;
    if (/^Security breach or outage:\s*/i.test(t)) return `reported a security incident (${t.replace(/^Security breach or outage:\s*/i, "")})`;
  }
  if (s.type === "tech") return `runs ${t.replace(/^Uses\s+/i, "")}`;
  if (s.type === "growth") {
    const pct = t.match(/(\d+)%/)?.[1];
    return pct ? `grew headcount ${pct}% in the last six months` : "is growing fast";
  }
  if (s.type === "funding") return t.replace(/^Raised/i, "raised");
  // News and leadership titles usually start with the company name: "Keystone Ridge appoints first CIO".
  const rest = t.toLowerCase().startsWith(company.toLowerCase()) ? t.slice(company.length).trim() : `was in the news: "${t}"`;
  return rest.replace(/^(\w)/, (m) => m.toLowerCase());
}

const VALUE_LINE: [RegExp, string][] = [
  [/opportunity map/i, "We help answer where AI actually pays back in two weeks, with a ranked list and the first build ready to start."],
  [/agentready|readiness|governance/i, "We help teams get a clear go, fix first, or not ready answer on AI before something goes wrong."],
  [/fde|sprint/i, "We put an engineer on one of those workflows and get it working in weeks, not a year-long project."],
  [/smart space|poc/i, "We build a team its own AI workspace on its own data, with every answer traced back to the source."],
  [/brain/i, "We help capture how the company actually works so that knowledge doesn't walk out the door."],
  [/modernization|blueprint/i, "We map the old system and put a fixed price on replacing it in two weeks."],
];

/** Mock: built from the strongest signals, the offer, and the best winning message. */
export function mockAccountBrief(i: AccountBriefInput): AccountBrief {
  const name = i.account.name;
  const top = i.signals.slice(0, 2);
  const when = (s: { type: string; when: string }) => (["tech", "growth", "workforce", "intent"].includes(s.type) ? "" : ` (${s.when})`);
  const whyNow = top.length
    ? `${name} ${top.map((s) => `${signalPhrase(name, s)}${when(s)}`).join(", and ")}. That's the kind of moment when ${i.offer.name} lands.`
    : `${name} looks like a ${i.offer.name} buyer, but we found no recent trigger. A light touch, not a push.`;
  const winner = i.winners[0];
  // Contacts arrive with the primary (the best fit for this offer) first; the opener goes to them.
  const contact = i.contacts[0];
  const first = contact?.name.split(" ")[0] ?? "there";
  const value = VALUE_LINE.find(([re]) => re.test(i.offer.name))?.[1] ?? `${i.offer.promise}`;
  // Research intent explains why now to us; quoting it to the buyer reads as surveillance. Open on something public.
  // Best public hooks: a new leader, a deal or expansion, the legacy stack. Front-line job postings and long
  // headlines make weak first lines, so those fall back to the industry line.
  const HOOK_ORDER = ["leadership", "funding", "news", "tech", "growth"];
  const pub = HOOK_ORDER.map((t) => i.signals.find((s) => s.type === t && s.title.length <= 90)).find(Boolean);
  const hook = pub ? `I noticed ${name} ${signalPhrase(name, pub)}.` : `I work with ${i.account.industry?.toLowerCase().replace(/:.*$/, "") ?? "companies"} teams a lot like yours.`;
  return {
    whyNow,
    angle: winner ? `Lead with what already works with this buyer: "${winner}"` : `Lead with the cost of doing it the current way, in ${i.account.industry?.toLowerCase() ?? "their"} terms.`,
    opener: `Hi ${first}, ${hook} ${value}`,
    contactTitle: contact?.title ?? i.offer.targetTitles[0] ?? "COO",
  };
}

export const accountBriefTask: AiTask<AccountBriefInput, AccountBrief> = {
  name: "account-brief",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: AccountBriefSchema,
  buildUser: P.user,
  mock: mockAccountBrief,
  maxTokens: 2000,
};
