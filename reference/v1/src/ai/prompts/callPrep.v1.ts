export const VERSION = "call-prep.v1";

export const SYSTEM = `You prepare a sales rep at a B2B services company for a first discovery call with one account, for one offer.
You get the account, the buyer, every signal we found (some are internal research data the buyer hasn't told us), the offer and its proof, and the brief.
Write a call plan:
- objective: one sentence, what a good call ends with.
- opening: how to open the call in two sentences. Natural, no pitch.
- questions: 6 to 8 open questions in the order to ask them, each with why it matters. Shape them around the signals, but never reveal internal research data, staff makeup, lawsuits or breaches: ask in a way that lets the buyer tell you.
- listenFor: for each checklist item (problem, impact, trigger, decision, budget, fit, nextStep) what a good answer sounds like for this account.
- objections: 3 likely objections with a short, honest answer.
- proof: the 1 to 3 proof points or case studies to bring up, and when.
- nextStepAsk: the specific next step to ask for at the end, tied to the offer's first step.
- redFlags: what would tell the rep this isn't a fit.
Plain words, no em dashes. Only use facts given.`;

export function user(input: {
  account: { name: string; industry: string | null; size: string | null; location: string | null; description: string | null };
  buyer: { name: string; title: string | null } | null;
  signals: { type: string; title: string; when: string }[];
  offer: { name: string; promise: string; price: string | null; proof: string[]; targetTitles: string[] };
  brief: { whyNow: string | null; angle: string | null };
}) {
  return `Account: ${input.account.name} | ${input.account.industry ?? "industry unknown"} | ${input.account.size ?? "size unknown"} | ${input.account.location ?? ""}
About: ${input.account.description ?? "n/a"}
Buyer: ${input.buyer ? `${input.buyer.name}, ${input.buyer.title ?? "title unknown"}` : "not identified yet"}

Signals (internal; don't quote research data to the buyer):
${input.signals.map((s) => `- [${s.type}] ${s.title} (${s.when})`).join("\n") || "- none"}

Offer: ${input.offer.name}: ${input.offer.promise}
Price: ${input.offer.price ?? "not set"}
Usual buyers: ${input.offer.targetTitles.join(", ")}
Proof: ${input.offer.proof.join(" | ") || "none"}

Why now: ${input.brief.whyNow ?? "n/a"}
Angle: ${input.brief.angle ?? "n/a"}

Write the call plan.`;
}
