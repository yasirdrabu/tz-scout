// One handoff message per rep per push, instead of a HubSpot alert per task. Pure: the server gathers
// the accounts, this writes the text someone posts in Teams (or that we send for them later).

export type HandoffAccount = {
  name: string;
  domain: string;
  offer: string | null;
  buyer: { name: string; title: string | null; email: string | null } | null;
  hubspotUrl: string | null;
};

export type HandoffMessage = { sellerId: string | null; seller: string; count: number; text: string };

const first = (name: string) => name.split(" ")[0] ?? name;

/** Two working days out, for the ask. */
export function replyBy(at: Date): Date {
  const d = new Date(at);
  let left = 2;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d;
}

export function handoffMessage(input: { seller: string; from: string | null; accounts: HandoffAccount[]; at?: Date }): string {
  const at = input.at ?? new Date();
  const n = input.accounts.length;
  const by = replyBy(at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const lines = input.accounts.map((a, i) => {
    const who = a.buyer ? `Start with ${a.buyer.name}${a.buyer.title ? `, ${a.buyer.title}` : ""}${a.buyer.email ? ` (${a.buyer.email})` : ""}.` : "No buyer contact yet; the note lists who to look for.";
    return `${i + 1}. ${a.name} (${a.domain})${a.offer ? `: ${a.offer}` : ""}. ${who}${a.hubspotUrl ? `\n   ${a.hubspotUrl}` : ""}`;
  });
  return [
    `Hi ${first(input.seller)}, ${n === 1 ? "1 new account is" : `${n} new accounts are`} in HubSpot for you.`,
    "",
    ...lines,
    "",
    `Each one has a note on the company with why it's a fit, why now, the offer and who to talk to, plus a first-touch task due today and three dated follow-up emails as tasks (days 3, 7 and 14). They're under your Tasks in HubSpot.`,
    "",
    `Ask: make the first touch on ${n === 1 ? "it" : "each"} by ${by}, and mark the tasks done in HubSpot as you go so we can see where they stand. If one isn't a fit, say so and I'll pull it back.`,
    ...(input.from ? ["", first(input.from)] : []),
  ].join("\n");
}

/** Group a batch's accounts by rep and write one message each. */
export function handoffMessages(input: { from: string | null; accounts: (HandoffAccount & { sellerId: string | null; seller: string | null })[]; at?: Date }): HandoffMessage[] {
  const groups = new Map<string, { sellerId: string | null; seller: string; accounts: HandoffAccount[] }>();
  for (const a of input.accounts) {
    const key = a.sellerId ?? "none";
    const g = groups.get(key) ?? { sellerId: a.sellerId, seller: a.seller ?? "Unassigned", accounts: [] };
    g.accounts.push(a);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ sellerId: g.sellerId, seller: g.seller, count: g.accounts.length, text: handoffMessage({ seller: g.seller, from: input.from, accounts: g.accounts, at: input.at }) }));
}
