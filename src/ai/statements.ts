// AI tasks for Module 3: write test statements for a segment, and rewrite a statement that failed.

import { z } from "zod";
import type { AiTask } from "./run";
import * as P from "./prompts/statements.v1";
import { STATEMENT_LIBRARY } from "./mock/segmentLibrary";
import { rng } from "@/lib/rand";

export const StatementsSchema = z.object({
  statements: z.array(z.object({ kind: z.enum(["PROBLEM", "OUTCOME"]), text: z.string() })),
});
export type StatementsOutput = z.infer<typeof StatementsSchema>;

export type StatementsInput = { segmentKey: string; buyer: string; problem: string; industry: string | null; promise: string; count: number; winners: string[] };

const PROBLEM_TEMPLATES = [
  (p: string) => `We are still ${p} and it costs us every week.`,
  () => `I spend more time chasing updates than making decisions.`,
  () => `We tried software for this and ended up back in spreadsheets.`,
  () => `I can't grow the business without adding headcount for this.`,
  () => `Nobody owns this problem, so it never gets fixed.`,
  () => `Every quarter we say we'll fix it next quarter.`,
  () => `The people who know how this works are already stretched thin.`,
];
const OUTCOME_TEMPLATES = [
  () => `One workflow fixed for real in weeks, not a year-long project.`,
  () => `Get my team's hours back for the work that grows revenue.`,
  () => `A fixed price and a clear plan before we commit more.`,
  () => `See the payback on paper before we spend a dollar on build.`,
  () => `Run the same process with half the manual steps.`,
  () => `A result my board can see in 90 days.`,
  () => `Stop depending on one person to keep this running.`,
];

const words = (s: string) => s.split(/\s+/).length;

export function mockStatements(input: StatementsInput): StatementsOutput {
  const lib = STATEMENT_LIBRARY[input.segmentKey];
  const half = Math.ceil(input.count / 2);
  const problem = input.problem.replace(/^(with|who|where|whose|that)\s+/i, "");
  const problems = (lib?.problems ?? []).concat(PROBLEM_TEMPLATES.map((t) => t(problem)));
  const outcomes = (lib?.outcomes ?? []).concat(OUTCOME_TEMPLATES.map((t) => t()));
  const skip = new Set(input.winners.map((w) => w.toLowerCase()));
  const take = (xs: string[], n: number) => [...new Set(xs)].filter((x) => !skip.has(x.toLowerCase()) && words(x) <= 25).slice(0, n);
  return {
    statements: [
      ...take(problems, half).map((text) => ({ kind: "PROBLEM" as const, text })),
      ...take(outcomes, input.count - half).map((text) => ({ kind: "OUTCOME" as const, text })),
    ],
  };
}

export const statementsTask: AiTask<StatementsInput, StatementsOutput> = {
  name: "statements",
  promptVersion: P.VERSION,
  system: P.SYSTEM,
  schema: StatementsSchema,
  buildUser: (i) => P.user({ buyer: i.buyer, problem: i.problem, industry: i.industry, promise: i.promise, count: i.count, winners: i.winners }),
  mock: mockStatements,
  maxTokens: 4000,
};

export const RewriteSchema = z.object({ text: z.string(), why: z.string() });
export type RewriteInput = { statement: string; kind: "PROBLEM" | "OUTCOME"; buyer: string; winners: string[] };

export function mockRewrite(input: RewriteInput): z.infer<typeof RewriteSchema> {
  const r = rng(input.statement);
  const winner = input.winners[Math.floor(r() * input.winners.length)];
  const core = input.statement.replace(/[.!?]+$/, "");
  if (input.kind === "PROBLEM") {
    const text = winner && /\bI\b|\bmy\b/i.test(winner) ? `Honestly, ${core.charAt(0).toLowerCase()}${core.slice(1)}, and I'm the one who answers for it.` : `${core}, and it lands on my desk every week.`;
    return { text: text.split(/\s+/).slice(0, 25).join(" "), why: "Winners with this buyer are personal and specific about who carries the pain." };
  }
  return { text: `${core} in weeks, at a fixed price.`.split(/\s+/).slice(0, 25).join(" "), why: "Winning outcomes name a short timeframe and a known cost." };
}

export const rewriteTask: AiTask<RewriteInput, z.infer<typeof RewriteSchema>> = {
  name: "statement-rewrite",
  promptVersion: P.REWRITE_VERSION,
  system: P.REWRITE_SYSTEM,
  schema: RewriteSchema,
  buildUser: P.rewriteUser,
  mock: mockRewrite,
  maxTokens: 1000,
};
