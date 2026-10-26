// Default buying signals per offering, from the signal framework (docs/SIGNALS.md). Editable per
// offering in the app. Research intent counts most, then trigger events, then visible pain.
// Weights are points (0 to 100) a rule can add to the signal score; every rule says why it matters.

import type { SignalRule } from "./matching";

const r = (id: string, type: SignalRule["type"], label: string, weight: number, match: string[], why: string, min?: number): SignalRule => ({ id, type, label, weight, match, why, ...(min != null ? { min } : {}) });

const INTENT_MIN = 0.6; // a research score of 60 or more

export const DEFAULT_SIGNAL_RULES: Record<string, SignalRule[]> = {
  "ai-opportunity-map": [
    r("om-intent", "intent", "Researching AI strategy or readiness", 40,
      ["ai strategy", "ai readiness", "ai transformation", "ai value measurement", "genai readiness", "ai consulting", "enterprise ai", "ai change management", "digital strategy", "generative artificial intelligence"],
      "They're actively researching where AI fits in their business: the exact question the Opportunity Map answers in two weeks.", INTENT_MIN),
    r("om-new-leader", "leadership", "New CEO, COO or CIO", 25,
      ["ceo", "chief executive", "coo", "chief operating", "cio", "chief information", "president", "chief digital"],
      "New leaders spend their first 90 days deciding what to change. A ranked AI plan is an early, visible win for them."),
    r("om-funding", "funding", "Private equity deal or new funding", 20, [],
      "New owners and investors push for a growth or margin plan, and AI is on every board's list."),
    r("om-ma", "news", "Acquisition or merger", 15, ["acqui", "merger"],
      "Combining companies surfaces duplicated work and systems: obvious first places for AI."),
    r("om-cost", "news", "Cost-cutting mandate", 15, ["cost cutting", "layoff", "restructur", "reduction"],
      "A mandate to do more with less is the business case for AI, once someone shows where it pays back."),
    r("om-ai-hire", "hiring", "Hiring an AI or data leader", 15, ["ai", "machine learning", "data science", "head of data", "automation", "digital transformation"],
      "Hiring for AI without a plan for where it applies is a common gap. The map gives that hire a roadmap."),
    r("om-growth", "growth", "Headcount up 10% or more", 10, [],
      "Fast growth strains processes built for a smaller company.", 0.1),
  ],
  "agentready-diagnostic": [
    r("ar-intent", "intent", "Researching AI governance or risk", 40,
      ["ai governance", "responsible ai", "ai risk", "ai usage control", "artificial intelligence compliance", "ai security", "ai safety", "model governance", "ai internal audit", "generative ai visibility"],
      "They're researching how to control AI use: the question AgentReady answers, can we do this safely?", INTENT_MIN),
    r("ar-risk", "risk", "Security breach, outage or lawsuit", 25, [],
      "After an incident, leadership has to prove its systems and AI use are under control, and fast."),
    r("ar-ai-tools", "tech", "Already using AI tools", 20, ["openai", "copilot", "chatgpt", "anthropic", "claude", "gemini", "azure openai", "bedrock", "sagemaker", "comprehend"],
      "AI is already in use. Governance usually lags adoption by a year or more, which is the gap the diagnostic finds."),
    r("ar-new-risk-owner", "leadership", "New CIO, CISO or compliance leader", 15, ["cio", "chief information", "ciso", "security", "cto", "chief technology", "compliance", "privacy"],
      "New risk owners baseline what they've inherited in their first months."),
    r("ar-hiring", "hiring", "Hiring for security, privacy or compliance", 15, ["security", "privacy", "compliance", "risk", "governance"],
      "They know there's a gap and are staffing for it. An outside diagnostic moves faster than a hire."),
  ],
  "modernization-blueprint": [
    r("mb-intent", "intent", "Researching legacy modernization", 40,
      ["legacy system modernization", "application modernization", "database modernization", "healthcare it modernization", "policy administration system modernization", "application migration", "mainframe modernization", "cobol conversion", "platform modernization", "erp transformation", "software migration", "legacy data"],
      "They're researching how to replace an old system. The Blueprint puts a fixed price on Release 1 in two weeks.", INTENT_MIN),
    r("mb-legacy-tech", "tech", "Running legacy software", 30, ["microsoft access", "visual basic", "vb6", "foxpro", "lotus notes", "as/400", "ibm i", "classic asp", "delphi", "cobol", "oracle forms", "powerbuilder", "coldfusion", "silverlight", "oracle9i", "oracle 10g"],
      "Old platforms nobody can hire for are a ticking clock, and the business usually knows it."),
    r("mb-legacy-hiring", "hiring", "Hiring to keep an old system running", 20, ["access developer", "vb6", "legacy", "as/400", "cobol", "foxpro", "oracle forms", "powerbuilder", "coldfusion"],
      "Paying people to keep an old system alive is the cost a rebuild replaces."),
    r("mb-ma", "news", "Acquisition to integrate", 15, ["acqui", "merger"],
      "Mergers leave two systems doing one job. Someone has to pick and rebuild."),
    r("mb-risk", "risk", "Outage or breach", 15, [],
      "Old systems fail and leak. An incident turns 'someday' into a budget line."),
    r("mb-leader", "leadership", "Key technologist leaving, or a new CIO", 10, ["retire", "steps down", "cio", "chief information", "cto", "chief technology"],
      "When the one person who understands the system leaves, or a new CIO arrives, the old system gets a hard look."),
  ],
  "fde-sprint": [
    r("fde-intent", "intent", "Researching workflow automation", 40,
      ["workflow automation", "automated workflow", "digital process automation", "business process automation", "intelligent automation", "healthcare automation", "ai automation", "approval workflow", "reporting automation", "compliance automation"],
      "They're looking for a way to automate a specific workflow. The Sprint gets one working in their environment in weeks.", INTENT_MIN),
    r("fde-ops-share", "workforce", "Large operations team", 20, ["operations is"],
      "When operations is a big share of headcount, manual work is happening at scale. That's where automation pays back fastest.", 0.15),
    r("fde-ops-growing", "workforce", "Operations team growing", 15, ["operations team growing", "hiring in operations"],
      "Adding people to keep up with volume is the moment to fix the workflow instead."),
    r("fde-manual-hiring", "hiring", "Hiring for repetitive work", 20, ["data entry", "clerk", "dispatcher", "intake", "processor", "prior authorization", "billing", "coding specialist", "claims", "lease administrator", "accounts payable"],
      "Every hire for repetitive work is a workflow an engineer could take over."),
    r("fde-new-ops", "leadership", "New operations leader", 15, ["coo", "chief operating", "operations"],
      "New operations leaders look for quick, visible improvements."),
    r("fde-growth", "growth", "Headcount up 10% or more", 10, [], "Volume is outgrowing the way work gets done.", 0.1),
  ],
  "smart-space-poc": [
    r("ss-intent", "intent", "Researching knowledge tools or AI assistants", 40,
      ["knowledge management", "knowledge capture", "centralized knowledge", "enterprise search", "retrieval-augmented generation", "conversational ai", "enterprise ai", "intelligent content management", "large language model", "document management"],
      "They want their people to find answers in their own documents, which is what a Smart Space does for one department.", INTENT_MIN),
    r("ss-analysts", "hiring", "Hiring analysts or researchers", 20, ["analyst", "research", "due diligence", "underwriting", "medical affairs", "knowledge"],
      "Analyst teams spend their days assembling answers from documents. That's the work a Smart Space speeds up."),
    r("ss-funding", "funding", "New funding or investment", 15, [], "New money funds new tools for the teams that drive the plan."),
    r("ss-ma", "news", "Acquisition activity", 15, ["acqui", "merger"], "Deal teams and integrations run on documents and diligence."),
    r("ss-data", "tech", "Data warehouse in place", 10, ["snowflake", "databricks", "redshift", "bigquery", "synapse"],
      "A modern data stack means a Smart Space can be connected quickly."),
  ],
  "company-brain": [
    r("cb-intent", "intent", "Researching knowledge capture", 40,
      ["knowledge capture", "centralized knowledge", "knowledge management", "organizational learning", "enterprise information management", "knowledge base"],
      "They're trying to capture how the company works before it walks out the door. That's the Company Brain.", INTENT_MIN),
    r("cb-ma", "news", "Acquisition, merger or expansion", 25, ["acqui", "merger", "new office", "expansion", "opens"],
      "Every acquisition or new site has to learn how the company does things, and usually learns it inconsistently."),
    r("cb-succession", "leadership", "Succession or a key leader leaving", 20, ["retire", "succession", "steps down", "appoints", "names"],
      "When long-time leaders leave, what they know leaves with them unless it's captured."),
    r("cb-growth", "growth", "Headcount up 15% or more", 15, [], "Fast hiring means onboarding at scale, where shared knowledge pays off.", 0.15),
  ],
};

/** Starting rules for an offering we don't have defaults for. */
export const GENERIC_SIGNAL_RULES: SignalRule[] = [
  r("gen-intent", "intent", "Researching AI or automation", 40, ["ai strategy", "ai readiness", "workflow automation", "enterprise ai"], "They're actively researching the problem this offer solves.", INTENT_MIN),
  r("gen-leadership", "leadership", "New senior leader", 25, ["chief", "president", "vp", "head of"], "New leaders have a mandate and room to start new work."),
  r("gen-funding", "funding", "New funding or investment", 20, [], "New money comes with a plan and a deadline."),
  r("gen-news", "news", "Acquisition or expansion", 15, ["acqui", "merger", "expansion"], "Change creates work that has to be organized."),
];

export function defaultRulesFor(slug: string): SignalRule[] {
  return DEFAULT_SIGNAL_RULES[slug] ?? GENERIC_SIGNAL_RULES;
}
