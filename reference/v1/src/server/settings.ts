import type { ScopedDb } from "@/lib/db";
import { DEFAULT_FUNNEL, DEFAULT_SCORECARD, DEFAULT_SEQUENCE, DEFAULT_TEST, type FunnelDefaults, type SequenceSettings, type TestDefaults } from "@/lib/defaults";
import { normalizeWeights, type Weights } from "@/lib/scoring";
import type { ScorecardConfig } from "@/lib/scorecard";

export type CompanySettings = {
  id: string;
  weights: Weights;
  maxActiveSegments: number;
  testDefaults: TestDefaults;
  funnelDefaults: FunnelDefaults;
  sequence: SequenceSettings;
  scorecard: ScorecardConfig;
  roundRobinIndex: number;
};

const obj = <T extends object>(v: unknown, fallback: T): T => (v && typeof v === "object" && !Array.isArray(v) ? { ...fallback, ...(v as object) } : fallback);

export async function getSettings(db: ScopedDb): Promise<CompanySettings> {
  const s = await db.settings.findFirst();
  if (!s) throw new Error("Company settings are missing. Run the seed or create the company from Admin.");
  const scorecardIn = obj<ScorecardConfig>(s.scorecard, {});
  const scorecard: ScorecardConfig = { ...DEFAULT_SCORECARD };
  for (const [k, v] of Object.entries(scorecardIn)) scorecard[k] = { ...(DEFAULT_SCORECARD[k] ?? {}), ...v };
  return {
    id: s.id,
    weights: normalizeWeights(s.weights as Record<string, number>),
    maxActiveSegments: s.maxActiveSegments,
    testDefaults: obj(s.testDefaults, DEFAULT_TEST),
    funnelDefaults: obj(s.funnelDefaults, DEFAULT_FUNNEL),
    sequence: obj(s.sequence, DEFAULT_SEQUENCE),
    scorecard,
    roundRobinIndex: s.roundRobinIndex,
  };
}
