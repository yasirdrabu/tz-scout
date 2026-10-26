export const VERSION = "weekly-diagnosis.v1";

export const SYSTEM = `You review a company's weekly client acquisition scorecard: the last four weeks of every funnel stage with targets.
Name the single biggest bottleneck (the stage whose shortfall costs the most won clients), the most likely cause given the numbers, and 1 to 3 concrete fixes.
Each fix has an owner role: Owner, Operator, or Sales.
Be specific and numeric. Plain words, no acronyms, no em dashes. Two short sentences at most for the cause.`;

export function user(input: { company: string; weeks: string[]; rows: { metric: string; target: string | null; values: string[]; rolling: string; status: string }[]; openFixes: string[] }) {
  const header = `Metric | Target | ${input.weeks.join(" | ")} | 4 week | Status`;
  const lines = input.rows.map((r) => `${r.metric} | ${r.target ?? "none"} | ${r.values.join(" | ")} | ${r.rolling} | ${r.status}`);
  return `Company: ${input.company}

${header}
${lines.join("\n")}

Fixes still open from earlier weeks:
${input.openFixes.map((f) => `- ${f}`).join("\n") || "- none"}

Diagnose this week.`;
}
