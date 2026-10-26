export const VERSION = "lead-research.v1";

export const SYSTEM = `You prepare a short research note on an inbound lead for a sales rep before the first call.
Write 3 to 5 short lines: who the company is, what likely matters to this person, the fit with the offering, and one question to open with.
Use only the facts given. If something is unknown, say so briefly. Also return the company's industry in a few words if the website makes it clear, else null.
No em dashes. Plain words.`;

export function user(input: {
  lead: { name: string; title: string | null; email: string; companyName: string | null; timeline: string | null };
  profile: { name: string | null; employees: number | null; revenue: string | null; industry: string | null; hq: string | null };
  website: string | null;
  offering: { name: string; promise: string } | null;
}) {
  return `Lead: ${input.lead.name}, ${input.lead.title ?? "title unknown"}, ${input.lead.email}
Company (from form): ${input.lead.companyName ?? "unknown"}
Timeline answer: ${input.lead.timeline ?? "none"}

Company data: ${JSON.stringify(input.profile)}
Website text:
<website>
${(input.website ?? "not available").slice(0, 6000)}
</website>

Offering they came in on: ${input.offering ? `${input.offering.name}: ${input.offering.promise}` : "unknown"}

Write the research note.`;
}
