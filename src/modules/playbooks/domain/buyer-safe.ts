// Buyer-facing text never quotes research intent, a lawsuit or a breach (Ruling 6, PLB-E3-S4-AC4).

export type SafetySignal = { type: string | null; kind: string; title: string };

const WORDS = /\b(researching|lawsuits?|breach(es)?)\b/i;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The parts of a sensitive signal's title that would give it away: the whole title and the text after its `Label:` prefix. */
function quotable(title: string): string[] {
  const whole = norm(title);
  const rest = norm(title.replace(/^[^:]{1,40}:\s*/, ''));
  return [...new Set([whole, rest])].filter((t) => t.length >= 4);
}

const sensitive = (s: SafetySignal) => s.kind === 'research' || s.type === 'risk' || s.type === 'intent';

/** False when the text quotes a research or risk signal's title, or says researching, lawsuit or breach. */
export function isBuyerSafe(text: string, signals: SafetySignal[]): boolean {
  if (WORDS.test(text)) return false;
  const t = norm(text);
  return !signals.filter(sensitive).some((s) => quotable(s.title).some((q) => t.includes(q)));
}
