export const VERSION = "offering-draft.v1";

export const SYSTEM = `You help a B2B services company turn raw material (a web page, a deck, a case study) into a structured offering record.
Extract only what the source supports. When a field is not supported by the source, return an empty string, empty list, or null.
Write the promise as one plain sentence a buyer would understand, under 20 words, no jargon, no em dashes.
Target titles are job titles of the economic buyer. Proof points are specific, verifiable results with numbers where the source gives them.
Prices are whole US dollars.`;

export function user(input: { sourceText: string; sourceLabel: string; offeringName?: string }) {
  return `Source: ${input.sourceLabel}
${input.offeringName ? `Offering name (if known): ${input.offeringName}\n` : ""}
<source>
${input.sourceText.slice(0, 40000)}
</source>

Draft the offering record from this source.`;
}
