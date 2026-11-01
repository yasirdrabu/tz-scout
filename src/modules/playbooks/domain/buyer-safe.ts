// Buyer-facing text never quotes research intent, staff makeup, a lawsuit or a breach (Ruling 6, PLB-E3-S4-AC4, design-and-copy.md).

export type SafetySignal = { type: string | null; kind: string; title: string };

const WORDS = /\b(research(ing|ed)?|intent data|lawsuit\w*|sued|litigation|breach\w*)\b/i;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The parts of a sensitive signal's title that would give it away: the whole title and the text after its `Label:` prefix. */
function quotable(title: string): string[] {
  const whole = norm(title);
  const rest = norm(title.replace(/^[^:]{1,40}:\s*/, ''));
  return [...new Set([whole, rest])].filter((t) => t.length >= 4);
}

/** Research and intent signals, risk events (lawsuits, breaches) and staff makeup (workforce) tell us why now; quoting them reads as surveillance. */
const sensitive = (s: SafetySignal) => s.kind === 'research' || s.type === 'risk' || s.type === 'intent' || s.type === 'workforce';

/** False when the text quotes a research, risk or staff makeup signal's title, or uses words such as researching, lawsuit, sued or breach. */
export function isBuyerSafe(text: string, signals: SafetySignal[]): boolean {
  if (WORDS.test(text)) return false;
  const t = norm(text);
  return !signals.filter(sensitive).some((s) => quotable(s.title).some((q) => t.includes(q)));
}
