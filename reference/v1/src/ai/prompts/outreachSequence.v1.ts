export const VERSION = "outreach-sequence.v1";

export const SYSTEM = `You write a short outbound email sequence for a B2B services company reaching one named buyer at one target account, for one offer.
You get the account, the buyer, the public signals we found (with dates), the offer and its proof, the opener already approved, and the sender's name.
Write exactly 4 emails:
1. Day 0: the opener, as a full email. Keep the approved opener's idea and voice.
2. Day 3: a different angle. A sharp question about the problem the offer solves, in the buyer's terms, or a second public signal.
3. Day 7: proof. One concrete result or the guarantee, and the offer's promise in one line.
4. Day 14: close the loop politely. Easy to say "not now".
Rules:
- Each body under 90 words. Subject under 8 words, lower friction, no clickbait.
- Plain words. No em dashes. No buzzwords ("synergy", "leverage", "cutting-edge"). No product names or acronyms the buyer wouldn't use.
- Reference at most one public signal per email (a hire, a new leader, an expansion, a deal, the systems they run). Never mention research or intent data, staff makeup, lawsuits or breaches: they tell us why now, but quoting them reads as surveillance.
- One clear, small ask per email (a reply, a 20-minute call). No calendar links.
- Address the buyer by first name; sign with the sender's first name.
- Only use facts given.`;

export function user(input: {
  account: { name: string; industry: string | null; location: string | null };
  buyer: { name: string; title: string | null } | null;
  signals: { type: string; title: string; when: string }[];
  offer: { name: string; promise: string; proof: string[] };
  opener: string | null;
  angle: string | null;
  sender: string | null;
}) {
  return `Account: ${input.account.name} (${input.account.industry ?? "industry unknown"}${input.account.location ? `, ${input.account.location}` : ""})
Buyer: ${input.buyer ? `${input.buyer.name}, ${input.buyer.title ?? "title unknown"}` : "not found yet (address as 'Hi there')"}

Public signals:
${input.signals.map((s) => `- [${s.type}] ${s.title} (${s.when})`).join("\n") || "- none"}

Offer: ${input.offer.name}: ${input.offer.promise}
Proof: ${input.offer.proof.join(" | ") || "none yet"}
Approved opener: ${input.opener ?? "none yet"}
Angle: ${input.angle ?? "n/a"}
Sender: ${input.sender ?? "the account owner"}

Write the 4 emails.`;
}
