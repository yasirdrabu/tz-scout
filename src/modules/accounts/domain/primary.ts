// Who to approach first at an account. Ported from v1 `pickPrimary`.

import { SENIORITY_RANK, isSeniority, seniorityFromTitle } from './seniority';

export type PrimaryCandidate = {
  id: string;
  title: string | null;
  /** Stated by a source. Falls back to the title when missing or not a known category. */
  seniority: string | null;
  emailStatus: string | null;
  /** A person pinned this contact as primary. */
  pinnedPrimary: boolean;
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A target matches when all its words appear in the title ("CIO" matches "Director, CIO Office"). */
function matchesTarget(title: string | null, targets: string[]): boolean {
  if (!title) return false;
  const have = new Set(words(title));
  return targets.some((target) => {
    const w = words(target);
    return w.length > 0 && w.every((x) => have.has(x));
  });
}

/** A pinned person wins. Otherwise a target-title match, then seniority rank, then a verified email. The first of equals wins. */
export function pickPrimary(people: PrimaryCandidate[], targetTitles: string[]): string | null {
  const pinned = people.find((p) => p.pinnedPrimary);
  if (pinned) return pinned.id;
  let best: { id: string; score: [number, number, number] } | null = null;
  for (const p of people) {
    const rank = SENIORITY_RANK[isSeniority(p.seniority) ? p.seniority : seniorityFromTitle(p.title)];
    const score: [number, number, number] = [matchesTarget(p.title, targetTitles) ? 1 : 0, rank, p.emailStatus === 'verified' ? 1 : 0];
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) {
      best = { id: p.id, score };
    }
  }
  return best?.id ?? null;
}
