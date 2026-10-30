import { offsetAt, wallClock } from '@/platform/time';

// One handoff message per rep per push, instead of a CRM alert per task. Pure: the service gathers the
// accounts, this writes the text someone posts in Teams. Carried from v1 `src/lib/handoff.ts`.

export type HandoffAccount = {
  name: string;
  domain: string;
  offer: string | null;
  buyer: { name: string; title: string | null; email: string | null } | null;
  crmUrl: string | null;
};

export type HandoffMessage = { sellerId: string | null; seller: string; count: number; text: string };

type Context = { at: Date; timezone: string; followUpDays: readonly number[] };

const first = (name: string) => name.split(' ')[0] ?? name;
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'];

/** Two working days out, as an instant at noon on that tenant calendar day. */
export function replyBy(at: Date, timezone: string): Date {
  const p = wallClock(at.getTime(), timezone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day));
  for (let left = 2; left > 0; ) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) left--;
  }
  const noon = day.getTime() + 12 * 3_600_000;
  return new Date(noon - offsetAt(noon, timezone));
}

/** `3`, `3 and 7`, `3, 7 and 14`. */
const dayList = (days: readonly number[]) => (days.length < 2 ? days.join('') : `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`);

function followUpText(days: readonly number[]): string {
  const n = days.length;
  if (n === 0) return '';
  return ` and ${WORDS[n] ?? n} dated follow-up ${n === 1 ? 'email as a task' : 'emails as tasks'} (${n === 1 ? 'day' : 'days'} ${dayList(days)})`;
}

export function handoffMessage(input: { seller: string; from: string | null; accounts: HandoffAccount[] } & Context): string {
  const n = input.accounts.length;
  const by = replyBy(input.at, input.timezone).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: input.timezone });
  const lines = input.accounts.map((a, i) => {
    const who = a.buyer
      ? `Start with ${a.buyer.name}${a.buyer.title ? `, ${a.buyer.title}` : ''}${a.buyer.email ? ` (${a.buyer.email})` : ''}.`
      : 'No buyer contact yet; the note lists who to look for.';
    return `${i + 1}. ${a.name} (${a.domain})${a.offer ? `: ${a.offer}` : ''}. ${who}${a.crmUrl ? `\n   ${a.crmUrl}` : ''}`;
  });
  return [
    `Hi ${first(input.seller)}, ${n === 1 ? '1 new account is' : `${n} new accounts are`} in HubSpot for you.`,
    '',
    ...lines,
    '',
    `Each one has a note on the company with why it's a fit, why now, the offer and who to talk to, plus a first-touch task due today${followUpText(input.followUpDays)}. They're under your Tasks in HubSpot.`,
    '',
    `Ask: make the first touch on ${n === 1 ? 'it' : 'each'} by ${by}, and mark the tasks done in HubSpot as you go so we can see where they stand. If one isn't a fit, say so and I'll pull it back.`,
    ...(input.from ? ['', first(input.from)] : []),
  ].join('\n');
}

/** Group a batch's accounts by rep and write one message each. */
export function handoffMessages(input: { from: string | null; accounts: (HandoffAccount & { sellerId: string | null; seller: string | null })[] } & Context): HandoffMessage[] {
  const groups = new Map<string, { sellerId: string | null; seller: string; accounts: HandoffAccount[] }>();
  for (const a of input.accounts) {
    const key = a.sellerId ?? 'none';
    const g = groups.get(key) ?? { sellerId: a.sellerId, seller: a.seller ?? 'Unassigned', accounts: [] };
    g.accounts.push(a);
    groups.set(key, g);
  }
  const { from, at, timezone, followUpDays } = input;
  return [...groups.values()].map((g) => ({
    sellerId: g.sellerId,
    seller: g.seller,
    count: g.accounts.length,
    text: handoffMessage({ seller: g.seller, from, accounts: g.accounts, at, timezone, followUpDays }),
  }));
}
