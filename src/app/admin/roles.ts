// Membership roles as admins see them. Safe to import from client components.

export const ROLES = ["OWNER", "OPERATOR", "SALES"] as const;
export type MemberRole = (typeof ROLES)[number];
export const ROLE_NAME: Record<MemberRole, string> = { OWNER: "Owner", OPERATOR: "Operator", SALES: "Sales" };
