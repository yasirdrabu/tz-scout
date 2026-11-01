// The follow-up emails after the first touch, from rules (Ruling 10): a port of v1's `mockOutreachSequence`
// laid over the tenant's follow-up days. The `outreach_sequence` task is R2.
import { AI_LABEL } from '@/modules/ai-tasks';
import type { BriefInput } from './brief-io';
import { isBuyerSafe } from './buyer-safe';
import { HOOK_ORDER, signalPhrase } from './rules-brief';

export type FollowUp = { day: number; subject: string; body: string };
export type Purpose = 'New angle' | 'Proof' | 'Close the loop';

export type FollowUpInput = {
  account: Pick<BriefInput['account'], 'name' | 'industry'>;
  offer: Pick<NonNullable<BriefInput['offer']>, 'name' | 'promise' | 'proofPoints'> | null;
  signals: BriefInput['signals'];
  buyer: { name: string } | null;
  days: readonly number[];
};

// The problem each offer solves, said the way a buyer would (v1).
const PAIN_QUESTION: [RegExp, string][] = [
  [/opportunity map/i, 'is there a clear answer yet on where AI would actually pay back for you, or is it still a list of ideas?'],
  [/agentready|readiness|governance/i, 'do you know today which AI tools your people are already using, and on what data?'],
  [/fde|sprint/i, 'which workflow still runs on spreadsheets and manual handoffs, and who owns fixing it?'],
  [/smart space|poc/i, "how long does it take your team to find the answer that's buried in your own documents?"],
  [/brain/i, 'if your most experienced person left tomorrow, how much of how the work gets done would leave with them?'],
  [/modernization|blueprint/i, 'what would it take to get a fixed price on replacing the system everyone works around?'],
];

/** By position: the first is New angle, the last Close the loop, the others Proof; one day only is Close the loop. */
export function purposeAt(i: number, n: number): Purpose {
  if (i === n - 1) return 'Close the loop';
  return i === 0 ? 'New angle' : 'Proof';
}

const ensureStop = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** One follow-up per day. Empty with no offer (the CRM then writes its own). Never quotes research, risk or intent signals. */
export function followUps(i: FollowUpInput): FollowUp[] {
  const offer = i.offer;
  if (!offer) return [];
  const first = i.buyer?.name.split(' ')[0] ?? 'there';
  const company = i.account.name;
  const industry = i.account.industry?.toLowerCase().replace(/:.*$/, '') ?? null;
  const hooks = HOOK_ORDER.flatMap((t) =>
    i.signals.filter((s) => s.type === t && s.kind !== 'research' && s.title.length <= 90 && isBuyerSafe(s.title, i.signals)),
  );
  // The opener used the first hook; the new angle takes the second (v1).
  const second = hooks[1];
  const question = PAIN_QUESTION.find(([re]) => re.test(offer.name))?.[1] ?? 'what would change if this got solved this quarter?';
  const proof = offer.proofPoints[0];
  const plainAngle = `Hi ${first}, a quick question for you: ${question}\n\nIf that's on your list, I can share how other ${industry ? `${industry} ` : ''}teams have handled it.`;
  const bodies: Record<Purpose, string> = {
    'New angle': second
      ? `Hi ${first}, one more thought. I saw ${company} ${signalPhrase(company, second)}. Moments like that usually raise a question: ${question}\n\nHappy to share what we've seen work.`
      : plainAngle,
    Proof: `Hi ${first}, ${proof ? ensureStop(proof.replace(/^Guarantee:\s*/i, 'our guarantee: ')) : `here's what ${offer.name} is in one line.`} ${ensureStop(offer.promise)}\n\nWould it help to see how that would look for ${company}?`,
    'Close the loop': `Hi ${first}, I'll close the loop here so I'm not crowding your inbox. If ${offer.name.toLowerCase()} isn't a priority right now, no problem at all. If it is, just reply with a good week and I'll make it easy.`,
  };
  // A safe fallback per purpose, without the offer's name or proof line.
  const fallbacks: Record<Purpose, string> = {
    'New angle': plainAngle,
    Proof: `Hi ${first}, ${ensureStop(offer.promise)}\n\nWould it help to see how that would look for ${company}?`,
    'Close the loop': `Hi ${first}, I'll close the loop here so I'm not crowding your inbox. If this isn't a priority right now, no problem at all. If it is, just reply with a good week and I'll make it easy.`,
  };
  const who = i.buyer?.name ?? company;
  const kept = i.days.flatMap((day, idx) => {
    const purpose = purposeAt(idx, i.days.length);
    const body = [bodies[purpose], fallbacks[purpose]].find((b) => isBuyerSafe(b, i.signals));
    // No safe body: the follow-up is left out.
    return body ? [{ day, purpose, body }] : [];
  });
  return kept.map((f, idx) => ({
    day: f.day,
    subject: `Follow-up ${idx + 1} of ${kept.length} (day ${f.day}): ${f.purpose}, email ${who}`,
    body: `${f.body}\n\n(${AI_LABEL.rules})`,
  }));
}
