/** The nine signal types. Offers keeps its own list because accounts imports offers; accounts owns the labels and guide. */
export const SIGNAL_TYPE_KEYS = ['intent', 'leadership', 'funding', 'news', 'risk', 'hiring', 'growth', 'workforce', 'tech'] as const;
export type SignalTypeKey = (typeof SIGNAL_TYPE_KEYS)[number];

export const SIGNAL_RULE_LIMITS = { rules: 50, keywords: 30, keyword: 60, label: 120, why: 500 } as const;

/** What a person sends for one rule. `minValue` is a decimal such as 0.6 for a research score or 0.1 for headcount growth. */
export type SignalRuleInput = {
  type: string;
  label: string;
  weight: number;
  match: string[];
  minValue: number | null;
  why: string;
  enabled: boolean;
};

export type SignalRuleDefault = Omit<SignalRuleInput, 'enabled'>;

export type SignalRuleProblem = { path: string; message: string };

export function signalRuleProblems(rules: SignalRuleInput[]): SignalRuleProblem[] {
  const out: SignalRuleProblem[] = [];
  if (rules.length > SIGNAL_RULE_LIMITS.rules) {
    out.push({ path: 'rules', message: `Use at most ${SIGNAL_RULE_LIMITS.rules} signal rules.` });
  }
  rules.forEach((r, i) => {
    const at = (field: string, message: string) => out.push({ path: `rules.${i}.${field}`, message });
    if (!(SIGNAL_TYPE_KEYS as readonly string[]).includes(r.type)) at('type', 'Pick a signal type.');
    if (!r.label.trim()) at('label', 'Add a label.');
    else if (r.label.trim().length > SIGNAL_RULE_LIMITS.label) {
      at('label', `Keep the label to ${SIGNAL_RULE_LIMITS.label} characters.`);
    }
    if (!Number.isInteger(r.weight) || r.weight < 0 || r.weight > 100) {
      at('weight', 'Points must be a whole number from 0 to 100.');
    }
    if (r.match.length > SIGNAL_RULE_LIMITS.keywords) {
      at('match', `Use at most ${SIGNAL_RULE_LIMITS.keywords} keywords per rule.`);
    } else {
      r.match.forEach((k, j) => {
        if (k.trim().length > SIGNAL_RULE_LIMITS.keyword) {
          out.push({ path: `rules.${i}.match.${j}`, message: `Keep each keyword to ${SIGNAL_RULE_LIMITS.keyword} characters.` });
        }
      });
    }
    if (r.minValue !== null && (!Number.isFinite(r.minValue) || r.minValue < 0)) {
      at('minValue', 'The minimum must be a number from 0 up.');
    }
    if (!r.why.trim()) at('why', 'Add why this signal matters.');
    else if (r.why.trim().length > SIGNAL_RULE_LIMITS.why) {
      at('why', `Keep the reason to ${SIGNAL_RULE_LIMITS.why} characters.`);
    }
  });
  return out;
}

// Default buying signals per offer, carried from v1 (src/lib/signalRules.ts). Research intent counts
// most, then trigger events, then visible pain. Points run 0 to 100 and every rule says why it matters.
const INTENT_MIN = 0.6; // a research score of 60 or more

const r = (type: SignalTypeKey, label: string, weight: number, match: string[], why: string, min?: number): SignalRuleDefault => ({
  type,
  label,
  weight,
  match,
  minValue: min ?? null,
  why,
});

export const DEFAULT_SIGNAL_RULES: Record<string, SignalRuleDefault[]> = {
  "ai-opportunity-map": [
    r("intent", "Researching AI strategy or readiness", 40,
      ["ai strategy", "ai readiness", "ai transformation", "ai value measurement", "genai readiness", "ai consulting", "enterprise ai", "ai change management", "digital strategy", "generative artificial intelligence"],
      "They're actively researching where AI fits in their business: the exact question the Opportunity Map answers in two weeks.", INTENT_MIN),
    r("leadership", "New CEO, COO or CIO", 25,
      ["ceo", "chief executive", "coo", "chief operating", "cio", "chief information", "president", "chief digital"],
      "New leaders spend their first 90 days deciding what to change. A ranked AI plan is an early, visible win for them."),
    r("funding", "Private equity deal or new funding", 20, [],
      "New owners and investors push for a growth or margin plan, and AI is on every board's list."),
    r("news", "Acquisition or merger", 15, ["acqui", "merger"],
      "Combining companies surfaces duplicated work and systems: obvious first places for AI."),
    r("news", "Cost-cutting mandate", 15, ["cost cutting", "layoff", "restructur", "reduction"],
      "A mandate to do more with less is the business case for AI, once someone shows where it pays back."),
    r("hiring", "Hiring an AI or data leader", 15, ["ai", "machine learning", "data science", "head of data", "automation", "digital transformation"],
      "Hiring for AI without a plan for where it applies is a common gap. The map gives that hire a roadmap."),
    r("growth", "Headcount up 10% or more", 10, [],
      "Fast growth strains processes built for a smaller company.", 0.1),
  ],
  "agentready-diagnostic": [
    r("intent", "Researching AI governance or risk", 40,
      ["ai governance", "responsible ai", "ai risk", "ai usage control", "artificial intelligence compliance", "ai security", "ai safety", "model governance", "ai internal audit", "generative ai visibility"],
      "They're researching how to control AI use: the question AgentReady answers, can we do this safely?", INTENT_MIN),
    r("risk", "Security breach, outage or lawsuit", 25, [],
      "After an incident, leadership has to prove its systems and AI use are under control, and fast."),
    r("tech", "Already using AI tools", 20, ["openai", "copilot", "chatgpt", "anthropic", "claude", "gemini", "azure openai", "bedrock", "sagemaker", "comprehend"],
      "AI is already in use. Governance usually lags adoption by a year or more, which is the gap the diagnostic finds."),
    r("leadership", "New CIO, CISO or compliance leader", 15, ["cio", "chief information", "ciso", "security", "cto", "chief technology", "compliance", "privacy"],
      "New risk owners baseline what they've inherited in their first months."),
    r("hiring", "Hiring for security, privacy or compliance", 15, ["security", "privacy", "compliance", "risk", "governance"],
      "They know there's a gap and are staffing for it. An outside diagnostic moves faster than a hire."),
  ],
  "modernization-blueprint": [
    r("intent", "Researching legacy modernization", 40,
      ["legacy system modernization", "application modernization", "database modernization", "healthcare it modernization", "policy administration system modernization", "application migration", "mainframe modernization", "cobol conversion", "platform modernization", "erp transformation", "software migration", "legacy data"],
      "They're researching how to replace an old system. The Blueprint puts a fixed price on Release 1 in two weeks.", INTENT_MIN),
    r("tech", "Running legacy software", 30, ["microsoft access", "visual basic", "vb6", "foxpro", "lotus notes", "as/400", "ibm i", "classic asp", "delphi", "cobol", "oracle forms", "powerbuilder", "coldfusion", "silverlight", "oracle9i", "oracle 10g"],
      "Old platforms nobody can hire for are a ticking clock, and the business usually knows it."),
    r("hiring", "Hiring to keep an old system running", 20, ["access developer", "vb6", "legacy", "as/400", "cobol", "foxpro", "oracle forms", "powerbuilder", "coldfusion"],
      "Paying people to keep an old system alive is the cost a rebuild replaces."),
    r("news", "Acquisition to integrate", 15, ["acqui", "merger"],
      "Mergers leave two systems doing one job. Someone has to pick and rebuild."),
    r("risk", "Outage or breach", 15, [],
      "Old systems fail and leak. An incident turns 'someday' into a budget line."),
    r("leadership", "Key technologist leaving, or a new CIO", 10, ["retire", "steps down", "cio", "chief information", "cto", "chief technology"],
      "When the one person who understands the system leaves, or a new CIO arrives, the old system gets a hard look."),
  ],
  "fde-sprint": [
    r("intent", "Researching workflow automation", 40,
      ["workflow automation", "automated workflow", "digital process automation", "business process automation", "intelligent automation", "healthcare automation", "ai automation", "approval workflow", "reporting automation", "compliance automation"],
      "They're looking for a way to automate a specific workflow. The Sprint gets one working in their environment in weeks.", INTENT_MIN),
    r("workforce", "Large operations team", 20, ["operations is"],
      "When operations is a big share of headcount, manual work is happening at scale. That's where automation pays back fastest.", 0.15),
    r("workforce", "Operations team growing", 15, ["operations team growing", "hiring in operations"],
      "Adding people to keep up with volume is the moment to fix the workflow instead."),
    r("hiring", "Hiring for repetitive work", 20, ["data entry", "clerk", "dispatcher", "intake", "processor", "prior authorization", "billing", "coding specialist", "claims", "lease administrator", "accounts payable"],
      "Every hire for repetitive work is a workflow an engineer could take over."),
    r("leadership", "New operations leader", 15, ["coo", "chief operating", "operations"],
      "New operations leaders look for quick, visible improvements."),
    r("growth", "Headcount up 10% or more", 10, [], "Volume is outgrowing the way work gets done.", 0.1),
  ],
  "smart-space-poc": [
    r("intent", "Researching knowledge tools or AI assistants", 40,
      ["knowledge management", "knowledge capture", "centralized knowledge", "enterprise search", "retrieval-augmented generation", "conversational ai", "enterprise ai", "intelligent content management", "large language model", "document management"],
      "They want their people to find answers in their own documents, which is what a Smart Space does for one department.", INTENT_MIN),
    r("hiring", "Hiring analysts or researchers", 20, ["analyst", "research", "due diligence", "underwriting", "medical affairs", "knowledge"],
      "Analyst teams spend their days assembling answers from documents. That's the work a Smart Space speeds up."),
    r("funding", "New funding or investment", 15, [], "New money funds new tools for the teams that drive the plan."),
    r("news", "Acquisition activity", 15, ["acqui", "merger"], "Deal teams and integrations run on documents and diligence."),
    r("tech", "Data warehouse in place", 10, ["snowflake", "databricks", "redshift", "bigquery", "synapse"],
      "A modern data stack means a Smart Space can be connected quickly."),
  ],
  "company-brain": [
    r("intent", "Researching knowledge capture", 40,
      ["knowledge capture", "centralized knowledge", "knowledge management", "organizational learning", "enterprise information management", "knowledge base"],
      "They're trying to capture how the company works before it walks out the door. That's the Company Brain.", INTENT_MIN),
    r("news", "Acquisition, merger or expansion", 25, ["acqui", "merger", "new office", "expansion", "opens"],
      "Every acquisition or new site has to learn how the company does things, and usually learns it inconsistently."),
    r("leadership", "Succession or a key leader leaving", 20, ["retire", "succession", "steps down", "appoints", "names"],
      "When long-time leaders leave, what they know leaves with them unless it's captured."),
    r("growth", "Headcount up 15% or more", 15, [], "Fast hiring means onboarding at scale, where shared knowledge pays off.", 0.15),
  ],
};

/** Starting rules for an offering we don't have defaults for. */
export const GENERIC_SIGNAL_RULES: SignalRuleDefault[] = [
  r("intent", "Researching AI or automation", 40, ["ai strategy", "ai readiness", "workflow automation", "enterprise ai"], "They're actively researching the problem this offer solves.", INTENT_MIN),
  r("leadership", "New senior leader", 25, ["chief", "president", "vp", "head of"], "New leaders have a mandate and room to start new work."),
  r("funding", "New funding or investment", 20, [], "New money comes with a plan and a deadline."),
  r("news", "Acquisition or expansion", 15, ["acqui", "merger", "expansion"], "Change creates work that has to be organized."),
];

/** The slug's defaults, or the generic set for an offer without any. */
export const defaultSignalRulesFor = (slug: string): SignalRuleDefault[] => DEFAULT_SIGNAL_RULES[slug] ?? GENERIC_SIGNAL_RULES;
