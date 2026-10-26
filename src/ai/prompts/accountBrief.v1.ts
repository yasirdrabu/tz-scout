export const VERSION = "account-brief.v1.2";

export const SYSTEM = `You help a B2B services company decide how to approach one target account for one offer.
You get the company's facts, the buying signals we found (with dates), the offer, our closest proof, and messages that have already worked with this kind of buyer.
Write:
- whyNow: one or two sentences naming the specific signals that make this a buying window, with dates in plain words ("posted an AI governance role three weeks ago"). Only use facts given.
- angle: one sentence on the pain to lead with, in the buyer's terms.
- opener: the first two sentences of a short email to the buyer. Specific, human, no flattery, no product name, no em dashes. Reference one public signal naturally (a hire, a new leader, an expansion, a deal). Never mention [intent] research signals, staff makeup, lawsuits or breaches to the buyer: they tell us why now, but quoting them reads as surveillance.
- contactTitle: the title of the person to approach first. When people are listed, it's the first one, and the opener is addressed to them by first name.
Plain words. No acronyms the buyer wouldn't use. No em dashes.`;

export function user(input: {
  account: { name: string; industry: string | null; employees: number | null; revenue: string | null; location: string | null; description: string | null; technologies: string[] };
  signals: { type: string; title: string; when: string }[];
  offer: { name: string; promise: string; targetTitles: string[]; proof: string[] };
  segment: string | null;
  winners: string[];
  contacts: { name: string; title: string | null }[];
}) {
  return `Account: ${input.account.name}
Industry: ${input.account.industry ?? "unknown"} | Employees: ${input.account.employees ?? "unknown"} | Revenue: ${input.account.revenue ?? "unknown"} | Location: ${input.account.location ?? "unknown"}
About: ${input.account.description ?? "n/a"}
Notable technology: ${input.account.technologies.join(", ") || "n/a"}

Buying signals:
${input.signals.map((s) => `- [${s.type}] ${s.title} (${s.when})`).join("\n") || "- none found"}

Offer: ${input.offer.name}: ${input.offer.promise}
Usual buyer titles: ${input.offer.targetTitles.join(", ")}
Proof: ${input.offer.proof.join(" | ") || "n/a"}
Closest segment: ${input.segment ?? "n/a"}
Messages that worked with this kind of buyer:
${input.winners.map((w) => `- ${w}`).join("\n") || "- none yet"}

People we found: ${input.contacts.map((c) => `${c.name} (${c.title ?? "title unknown"})`).join("; ") || "none yet"}

Write the brief.`;
}
