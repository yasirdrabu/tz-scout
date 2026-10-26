// Everything a rep needs in HubSpot to work an account, built from what we know, so nothing in the
// app is lost when an account is handed over: why it's a lead, why now, the offer and why it fits,
// every signal with its date, source and why it matters, what would make it stronger, the brief, the
// buyers, and the company. Pure and tested; src/server/crm.ts sends it.

import { KIND_LABEL, SIGNAL_EXPLAINER, type RuleHit, type SignalKind, type SignalType, type Tier } from "./matching";
import type { SequenceStep } from "@/ai/outreachSequence";
import type { ResearchEntry } from "./research";

export type ContextSignal = { id: string; type: string; title: string; detail: string | null; url: string | null; value: number | null; occurredAt: Date };
export type ContextFitPart = { label: string; points: number; max: number; note: string };
export type ContextMatch = {
  offering: string;
  tier: string;
  fit: number;
  signal: number;
  total: number;
  hits: RuleHit[];
  fitParts?: ContextFitPart[];
  whyNow: string | null;
  angle: string | null;
  opener: string | null;
  contactTitle: string | null;
};
export type ContextOffer = { name: string; promise: string | null; priceMinCents: number | null; priceMaxCents: number | null; salesCycleDays: number | null; targetTitles: string[]; proofPoints: string[]; caseStudies: { title: string; client: string; result: string; link: string | null }[] };
export type ContextContact = { name: string; title: string | null; email: string | null; emailStatus?: string | null; phone: string | null; linkedinUrl: string | null; primary?: boolean };
export type ContextAccount = { name: string; domain: string; industry: string | null; employeesRange: string | null; revenueRange: string | null; location: string | null; description: string | null; technologies: string[]; source: string; dataAsOf?: Date | null };

export type HubSpotContext = { html: string; props: Record<string, string | number | null>; taskSubject: string; taskBody: string };

/** HubSpot caps a note at 65,536 characters; stay well under. */
export const NOTE_LIMIT = 60_000;

const TIER_PROP: Record<Tier, string> = { act_now: "Act now", good_fit: "Good fit", watch: "Watch", not_fit: "Not a fit" };
const TIER_MEANING: Record<Tier, string> = {
  act_now: "Strong fit and a reason to buy now (research or a trigger event).",
  good_fit: "Looks like the buyer, but no research or trigger yet. Warm up, don't push.",
  watch: "Some signals, weaker fit.",
  not_fit: "Not a buyer for our offers.",
};
const SOURCE: Record<string, string> = { vibe: "Vibe Prospecting", apollo: "Apollo", manual: "Added by hand", hubspot: "HubSpot", research: "Taazaa ABM research", import: "Imported list" };
const KIND_ORDER: SignalKind[] = ["research", "trigger", "pain"];
const KIND_HELP: Record<SignalKind, string> = {
  research: "They're reading about the problem this offer solves, right now.",
  trigger: "Something changed that opens budget or forces a decision.",
  pain: "Evidence the problem exists. Strongest alongside research or a trigger.",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const day = (d: Date) => d.toISOString().slice(0, 10);
const round = (n: number) => Math.round(n);
const pts = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const money = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;
const undated = (t: string) => t === "intent" || t === "tech" || t === "workforce";

/** One line per signal for plain-text fields: "Researching: AI risk management (84)". */
export function signalLine(s: ContextSignal): string {
  const score = s.type === "intent" && s.value != null ? ` (${round(s.value * 100)})` : "";
  return `${s.title}${score}${undated(s.type) ? "" : `, ${day(s.occurredAt)}`}`;
}

const linked = (s: ContextSignal) => (s.url ? `<a href="${esc(s.url)}">${esc(signalLine(s))}</a>` : esc(signalLine(s)));
const withDetail = (s: ContextSignal) => `${linked(s)}${s.detail && s.type !== "intent" ? `: ${esc(s.detail.slice(0, 300))}` : ""}`;

export function buildHubSpotContext(input: {
  account: ContextAccount;
  best: ContextMatch | null;
  others: ContextMatch[];
  offer?: ContextOffer | null;
  /** Rules for the best offer that haven't fired: what would make this stronger. */
  missing?: { label: string; weight: number; why?: string }[];
  signals: ContextSignal[];
  contacts: ContextContact[];
  owner: string | null;
  appUrl?: string | null;
  briefBy?: string | null;
  /** The follow-up emails after the opener. */
  sequence?: SequenceStep[];
  /** The account's tier, when imported research lifted it above the best offer's. */
  tier?: string | null;
  /** ABM research from imported sheets, one entry per practice bucket. */
  research?: { bucket: string; entry: ResearchEntry }[];
  now?: Date;
}): HubSpotContext {
  const { account: a, best, others, signals, contacts, offer } = input;
  const now = input.now ?? new Date();
  const byId = new Map(signals.map((s) => [s.id, s]));
  const hits = best?.hits ?? [];
  const counted = new Set(hits.flatMap((h) => h.signalIds));
  const research = signals.filter((s) => s.type === "intent").sort((x, y) => (y.value ?? 0) - (x.value ?? 0));
  const ranked = [...hits].sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || y.points - x.points);
  const topLines = ranked.map((h) => {
    const first = h.signalIds.map((id) => byId.get(id)).find(Boolean);
    return `${KIND_LABEL[h.kind]}: ${h.label}${first ? ` (${signalLine(first)})` : h.matched[0] ? ` (${h.matched[0]})` : ""}`;
  });
  const tier = (input.tier ?? best?.tier ?? "not_fit") as Tier;
  const research0 = input.research ?? [];
  const lead = research0[0]?.entry ?? null;

  const parts: string[] = [];
  const h = (t: string) => parts.push(`<p><strong>${t}</strong></p>`);

  // ---------- Summary ----------
  parts.push(`<p><strong>Why ${esc(a.name)} is a lead</strong> (Taazaa acquisition system, ${day(now)})</p>`);
  if (best) {
    parts.push(
      `<p>Best offer: <strong>${esc(best.offering)}</strong> · <strong>${TIER_PROP[tier] ?? best.tier}</strong> · overall ${round(best.total)} of 100 (fit ${round(best.fit)}, buying signals ${round(best.signal)})${input.owner ? ` · Owner: ${esc(input.owner)}` : ""}</p>`,
    );
    parts.push(`<p><em>${esc(TIER_MEANING[tier] ?? "")}</em></p>`);
    if (best.whyNow) parts.push(`<p><strong>Why now:</strong> ${esc(best.whyNow)}</p>`);
    if (topLines.length) parts.push(`<p><strong>In short:</strong></p><ul>${topLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
  } else if (lead) {
    parts.push(`<p>Researched lead · <strong>${TIER_PROP[tier] ?? tier}</strong>${lead.score != null ? ` · research score ${lead.score} of 100` : ""}${input.owner ? ` · Owner: ${esc(input.owner)}` : ""}</p>`);
    parts.push(`<p><em>${esc(TIER_MEANING[tier] ?? "")}</em></p>`);
  }

  // ---------- The research (imported ABM sheets) ----------
  for (const { bucket, entry: r } of research0) {
    h(`The research: ${esc(bucket)}${r.tier ? `, tier ${r.tier}` : ""}${r.score != null ? ` (${r.score} of 100)` : ""}`);
    parts.push("<ul>");
    if (r.signal) parts.push(`<li><strong>Why now</strong>: ${r.signal.url ? `<a href="${esc(r.signal.url)}">${esc(r.signal.title)}</a>` : esc(r.signal.title)} (${esc(r.signal.date)})</li>`);
    if (r.hook) parts.push(`<li><strong>Suggested opening</strong>: "${esc(r.hook)}"</li>`);
    if (r.problem) parts.push(`<li><strong>Likely problem</strong> (a hypothesis to test, not a fact): ${esc(r.problem)}</li>`);
    if (r.useCase) parts.push(`<li><strong>What we'd propose</strong>: ${esc(r.useCase)}</li>`);
    if (r.pilot) parts.push(`<li><strong>Paid first step</strong>: ${esc(r.pilot)}${r.price && !r.pilot.includes("$") ? ` (${esc(r.price)})` : ""}</li>`);
    if (r.roi) parts.push(`<li><strong>Value case</strong> (hypothesis, not a promise): ${esc(r.roi)}</li>`);
    if (r.approach) parts.push(`<li><strong>Approach</strong>: ${esc(r.approach)}</li>`);
    if (r.nextAction) parts.push(`<li><strong>Next step the research suggests</strong>: ${esc(r.nextAction)}</li>`);
    if (r.incumbent) parts.push(`<li><strong>Already working with</strong>: ${esc(r.incumbent)}</li>`);
    if (r.caveats) parts.push(`<li><strong>Watch out</strong>: ${esc(r.caveats)}</li>`);
    if (r.tech) parts.push(`<li><strong>Tech seen</strong>: ${esc(r.tech)}</li>`);
    if (r.scale) parts.push(`<li><strong>Size</strong>: ${esc(r.scale)}</li>`);
    if (r.contactRoute) parts.push(`<li><strong>Public contact route</strong>: ${esc(r.contactRoute)}</li>`);
    parts.push("</ul>");
    parts.push(`<p><em>From the ${esc(bucket)} research sheet${r.reportDate ? ` of ${esc(r.reportDate)}` : ""}. Researched from public sources; verify before quoting numbers.</em></p>`);
  }

  // ---------- How to approach ----------
  if (best && (best.opener || best.angle || best.contactTitle)) {
    h("How to approach");
    const primary = contacts.find((c) => c.primary) ?? contacts[0];
    parts.push("<ul>");
    if (primary) parts.push(`<li>Start with: <strong>${esc(primary.name)}</strong>${primary.title ? `, ${esc(primary.title)}` : ""}${primary.email ? ` (${esc(primary.email)})` : ""}</li>`);
    else if (best.contactTitle) parts.push(`<li>Start with: ${esc(best.contactTitle)}</li>`);
    if (best.angle) parts.push(`<li>Angle: ${esc(best.angle)}</li>`);
    if (best.opener) parts.push(`<li>Opener: "${esc(best.opener)}"</li>`);
    parts.push("</ul>");
    if (input.briefBy) parts.push(`<p><em>${esc(input.briefBy)}</em></p>`);
  }

  // ---------- Follow-up plan ----------
  if (input.sequence?.length) {
    h("Follow-up plan");
    parts.push(`<ol>${input.sequence.map((s) => `<li><strong>Day ${s.day}, ${esc(s.purpose)}</strong>: "${esc(s.subject)}"<br>${esc(s.body).replace(/\n/g, "<br>")}</li>`).join("")}</ol>`);
  }

  // ---------- The offer ----------
  if (offer) {
    h(`The offer: ${esc(offer.name)}`);
    parts.push("<ul>");
    if (offer.promise) parts.push(`<li>What it is: ${esc(offer.promise)}</li>`);
    if (offer.priceMinCents != null) parts.push(`<li>Price: ${offer.priceMaxCents && offer.priceMaxCents !== offer.priceMinCents ? `${money(offer.priceMinCents)} to ${money(offer.priceMaxCents)}` : money(offer.priceMinCents)}</li>`);
    if (offer.salesCycleDays) parts.push(`<li>Typical sales cycle: about ${offer.salesCycleDays} days</li>`);
    if (offer.targetTitles.length) parts.push(`<li>Usual buyers: ${esc(offer.targetTitles.join(", "))}</li>`);
    for (const p of offer.proofPoints) parts.push(`<li>Proof: ${esc(p)}</li>`);
    for (const c of offer.caseStudies) parts.push(`<li>Case study: ${c.link ? `<a href="${esc(c.link)}">${esc(c.title)}</a>` : esc(c.title)} (${esc(c.client)}): ${esc(c.result)}</li>`);
    parts.push("</ul>");
  }

  // ---------- Why it fits ----------
  if (best?.fitParts?.length) {
    h(`Why it fits (${round(best.fit)} of 100)`);
    parts.push(`<ul>${best.fitParts.map((f) => `<li>${esc(f.label)}: ${pts(f.points)} of ${f.max}${f.note ? `. ${esc(f.note)}` : ""}</li>`).join("")}</ul>`);
  }

  // ---------- Buying signals ----------
  if (ranked.length) h(`Buying signals (${round(best?.signal ?? 0)} of 100)`);
  for (const kind of KIND_ORDER) {
    const group = ranked.filter((x) => x.kind === kind);
    if (!group.length) continue;
    parts.push(`<p><strong>${KIND_LABEL[kind]}</strong>: ${esc(KIND_HELP[kind])}</p><ul>`);
    for (const hit of group) {
      const ev = hit.signalIds.map((id) => byId.get(id)).filter((s): s is ContextSignal => !!s);
      const evidence = ev.length ? ev.map(withDetail).join("<br>") : esc(hit.matched.join(", "));
      const explain = SIGNAL_EXPLAINER[hit.type as SignalType];
      parts.push(
        `<li><strong>${esc(hit.label)}</strong> (${pts(hit.points)} of ${hit.max} points)<br>${evidence}${hit.why ? `<br><em>Why it matters: ${esc(hit.why)}</em>` : ""}${explain ? `<br><em>How to read it: ${esc(explain.read)}</em>` : ""}</li>`,
      );
    }
    parts.push("</ul>");
  }
  if (research.length) {
    h("Everything they're researching");
    parts.push(`<ul>${research.map((s) => `<li>${esc(s.title.replace(/^Researching:\s*/, ""))}: ${round((s.value ?? 0) * 100)} of 100${(s.value ?? 0) >= 0.8 ? " (strong spike)" : (s.value ?? 0) >= 0.6 ? " (active)" : ""}</li>`).join("")}</ul>`);
  }
  const rest = signals.filter((s) => !counted.has(s.id) && s.type !== "tech" && s.type !== "intent").sort((x, y) => y.occurredAt.getTime() - x.occurredAt.getTime());
  if (rest.length) {
    h("Other signals (not scored for this offer)");
    parts.push(`<ul>${rest.map((s) => `<li>${withDetail(s)}</li>`).join("")}</ul>`);
  }
  if (input.missing?.length) {
    h("Would make it stronger");
    parts.push(`<ul>${input.missing.map((m) => `<li>${esc(m.label)} (up to ${m.weight} points)${m.why ? `: ${esc(m.why)}` : ""}</li>`).join("")}</ul>`);
  }
  if (others.length) {
    h("Other offers that fit");
    parts.push(`<ul>${others.map((o) => `<li>${esc(o.offering)}: ${round(o.total)} overall (fit ${round(o.fit)}, signals ${round(o.signal)}), ${TIER_PROP[o.tier as Tier] ?? o.tier}</li>`).join("")}</ul>`);
  }

  // ---------- Buyers ----------
  h("Buyers found");
  if (contacts.length) {
    parts.push(
      `<ul>${contacts
        .map((c) => {
          const quality = c.email ? (c.emailStatus === "valid" ? " (verified)" : c.emailStatus === "catch_all" ? " (can't be verified)" : "") : "";
          return `<li>${c.primary ? "★ " : ""}${esc(c.name)}${c.title ? `, ${esc(c.title)}` : ""}${c.email ? ` · ${esc(c.email)}${quality}` : ""}${c.phone ? ` · ${esc(c.phone)}` : ""}${c.linkedinUrl ? ` · <a href="${esc(c.linkedinUrl)}">LinkedIn</a>` : ""}</li>`;
        })
        .join("")}</ul>`,
    );
  } else {
    parts.push(`<p>None yet. Contacts are added to this company when they're pulled.</p>`);
  }

  // ---------- Company ----------
  h("Company");
  const facts = [a.industry, a.employeesRange && `${a.employeesRange} employees`, a.revenueRange && `${a.revenueRange} revenue`, a.location, a.domain].filter(Boolean).join(" · ");
  if (facts) parts.push(`<p>${esc(facts)}</p>`);
  if (a.description) parts.push(`<p>${esc(a.description)}</p>`);
  if (a.technologies.length) {
    const flagged = new Set(hits.filter((x) => x.type === "tech").flatMap((x) => x.matched));
    const tech = [...a.technologies].sort((x, y) => Number(flagged.has(y)) - Number(flagged.has(x)) || x.localeCompare(y));
    parts.push(`<p><strong>Tech stack</strong> (${tech.length}${flagged.size ? `; flagged first: ${esc([...flagged].join(", "))}` : ""}): ${esc(tech.join(", "))}</p>`);
  }

  // ---------- Footer ----------
  parts.push(
    `<p><em>Source: ${esc(SOURCE[a.source] ?? a.source)}${a.dataAsOf ? `, data as of ${day(a.dataAsOf)}` : ""}. Scores: fit is how much they look like the offer's buyer; buying signals are research, trigger events and visible pain, newest counting most. ${input.appUrl ? `<a href="${esc(input.appUrl)}">Open in the acquisition system</a>. ` : ""}This note is refreshed each time the account is pushed; if it has been edited in HubSpot, a new note is added instead so nothing is overwritten.</em></p>`,
  );

  let html = parts.join("");
  if (html.length > NOTE_LIMIT) html = `${html.slice(0, NOTE_LIMIT - 200)}</p><p><em>Note trimmed to fit HubSpot's size limit. The full detail is in the acquisition system.</em></p>`;

  // ---------- Company fields ----------
  const props: Record<string, string | number | null> = {
    taazaa_best_offer: best?.offering ?? null,
    taazaa_tier: best || lead ? (TIER_PROP[tier] ?? null) : null,
    taazaa_bucket: research0.length ? research0.map((r) => r.bucket).join("; ") : null,
    taazaa_fit_score: best ? round(best.fit) : null,
    taazaa_signal_score: best ? round(best.signal) : null,
    taazaa_total_score: best ? round(best.total) : null,
    taazaa_why_now: best?.whyNow ?? (lead?.signal ? `${lead.signal.title} (${lead.signal.date})` : null),
    taazaa_top_signals: topLines.join("\n") || null,
    taazaa_research_topics: research.length ? research.slice(0, 8).map((s) => `${s.title.replace(/^Researching:\s*/, "")} (${round((s.value ?? 0) * 100)})`).join("; ") : null,
    taazaa_other_offers: others.length ? others.map((o) => `${o.offering} ${round(o.total)}`).join("; ") : null,
    taazaa_signal_source: SOURCE[a.source] ?? a.source,
    taazaa_last_pushed: now.toISOString(),
  };

  // ---------- Task for the owner ----------
  const primary = contacts.find((c) => c.primary) ?? contacts[0];
  const taskSubject = `Reach out to ${a.name}: ${best?.offering ?? (research0[0] ? research0[0].bucket : "best-fit offer")}`;
  const taskBody = [
    best ? `${TIER_PROP[tier]} · ${best.offering} · overall ${round(best.total)} (fit ${round(best.fit)}, signals ${round(best.signal)})` : null,
    best?.whyNow,
    !best && lead ? `${TIER_PROP[tier]} · ${research0[0]!.bucket}${lead.score != null ? ` · research score ${lead.score}` : ""}` : null,
    lead?.signal ? `Why now: ${lead.signal.title} (${lead.signal.date})` : null,
    lead?.hook ? `Suggested opening: ${lead.hook}` : null,
    lead?.pilot ? `Paid first step: ${lead.pilot}` : null,
    topLines.length ? `Signals:\n${topLines.map((l) => `- ${l}`).join("\n")}` : null,
    primary ? `Start with: ${primary.name}${primary.title ? `, ${primary.title}` : ""}${primary.email ? ` (${primary.email})` : ""}` : best?.contactTitle ? `Start with: ${best.contactTitle}` : null,
    best?.angle && `Angle: ${best.angle}`,
    input.sequence?.[0] ? `First email (send today)\nSubject: ${input.sequence[0].subject}\n\n${input.sequence[0].body}` : best?.opener && `Opener: ${best.opener}`,
    input.sequence && input.sequence.length > 1 ? `Then: ${input.sequence.slice(1).map((s) => `day ${s.day} ${s.purpose.toLowerCase()}`).join(", ")} (each is its own task)` : null,
    offer?.promise && `The offer: ${offer.promise}`,
    "Full context is in the note on the company.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { html, props, taskSubject, taskBody };
}
