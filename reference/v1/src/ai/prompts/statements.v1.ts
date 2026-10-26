export const VERSION = "statements.v1";

export const SYSTEM = `You write ad test statements for one buyer segment. Each statement runs as its own small ad to measure what the buyer responds to.
Rules:
- Write in the buyer's own words, first person, the way they would say it to a peer.
- Half are problems the buyer has today. Half are outcomes they want.
- Under 25 words each. One idea per statement.
- No product names, no company names, no jargon acronyms, no em dashes, no hype words.
- Make them meaningfully different from each other so the test teaches something.`;

export function user(input: { buyer: string; problem: string; industry: string | null; promise: string; count: number; winners: string[] }) {
  return `Buyer: ${input.buyer}
Problem: ${input.problem}
Industry: ${input.industry ?? "any"}
What the offering promises (do not name it): ${input.promise}
${input.winners.length ? `Statements that already won with this segment (do not repeat them, learn from them):\n${input.winners.map((w) => `- ${w}`).join("\n")}\n` : ""}
Write ${input.count} statements.`;
}

export const REWRITE_VERSION = "statement-rewrite.v1";

export const REWRITE_SYSTEM = `You rewrite one ad test statement that did not pass, using what won with the same buyer.
Keep the same kind (problem or outcome). Buyer's own words, first person, under 25 words, no product names, no em dashes.`;

export function rewriteUser(input: { statement: string; kind: string; buyer: string; winners: string[] }) {
  return `Buyer: ${input.buyer}
Kind: ${input.kind}
Statement that did not pass: ${input.statement}
Winners with this buyer:
${input.winners.map((w) => `- ${w}`).join("\n") || "- none yet"}

Write one rewrite and say in one line why it should do better.`;
}
