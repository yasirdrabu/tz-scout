// Who can do what. Owners approve segments and budgets; operators run tests, campaigns and fixes;
// sales sees validated leads and meetings and logs outcomes. Taazaa admins can do everything.

export type AppRole = "OWNER" | "OPERATOR" | "SALES" | "ADMIN";

export const ACTIONS = {
  "offering.edit": ["OWNER", "OPERATOR"],
  "offering.approve": ["OWNER"],
  "segment.generate": ["OWNER", "OPERATOR"],
  "segment.override": ["OWNER", "OPERATOR"],
  "segment.activate": ["OWNER"],
  "batch.edit": ["OWNER", "OPERATOR"],
  "batch.approve": ["OWNER"],
  "batch.launch": ["OWNER", "OPERATOR"],
  "funnel.edit": ["OWNER", "OPERATOR"],
  "lead.view": ["OWNER", "OPERATOR", "SALES"],
  "lead.override": ["OWNER", "OPERATOR", "SALES"],
  "lead.simulate": ["OWNER", "OPERATOR"],
  "meeting.update": ["OWNER", "OPERATOR", "SALES"],
  "scorecard.view": ["OWNER", "OPERATOR", "SALES"],
  "scorecard.edit": ["OWNER", "OPERATOR"],
  "fix.complete": ["OWNER", "OPERATOR", "SALES"],
  "settings.edit": ["OWNER"],
  "buyers.view": ["OWNER", "OPERATOR", "SALES"],
  "buyers.pull": ["OWNER", "OPERATOR"],
  "buyers.act": ["OWNER", "OPERATOR", "SALES"],
  "buyers.rules": ["OWNER", "OPERATOR"],
} as const satisfies Record<string, readonly AppRole[]>;

export type Action = keyof typeof ACTIONS;

export function can(role: AppRole, action: Action): boolean {
  if (role === "ADMIN") return true;
  return (ACTIONS[action] as readonly AppRole[]).includes(role);
}

const ALL = ["OWNER", "OPERATOR", "SALES", "ADMIN"] as const;
const BUILDERS = ["OWNER", "OPERATOR", "ADMIN"] as const;

/** Left nav, grouped in the order the work flows: find buyers, shape the offer, run campaigns, work the pipeline. */
export const NAV = [
  { href: "buyers", label: "Buyers", group: "Find buyers", roles: ALL },
  { href: "buyers/sent", label: "Sent", group: "Find buyers", roles: ALL },
  { href: "buyers/import", label: "Import", group: "Find buyers", roles: ALL },
  { href: "buyers/pulls", label: "Pulls", group: "Find buyers", roles: BUILDERS },
  { href: "buyers/signals", label: "Signals", group: "Find buyers", roles: ALL },
  { href: "offerings", label: "Offerings", group: "Offer", roles: BUILDERS },
  { href: "segments", label: "Segments", group: "Offer", roles: BUILDERS },
  { href: "wins", label: "Wins", group: "Offer", roles: BUILDERS },
  { href: "tests", label: "Message tests", group: "Campaigns", roles: BUILDERS },
  { href: "funnel", label: "Funnel model", group: "Campaigns", roles: BUILDERS },
  { href: "leads", label: "Leads", group: "Pipeline", roles: ALL },
  { href: "meetings", label: "Meetings", group: "Pipeline", roles: ALL },
  { href: "scorecard", label: "Scorecard", group: "Pipeline", roles: ALL },
  { href: "settings", label: "Settings", group: "", roles: ALL },
] as const satisfies readonly { href: string; label: string; group: string; roles: readonly AppRole[] }[];

export const ROLE_LABEL: Record<AppRole, string> = { OWNER: "Owner", OPERATOR: "Operator", SALES: "Sales", ADMIN: "Admin" };
