"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { scopedDb, unscopedDb } from "@/lib/db";
import { defaultSettings } from "@/lib/defaults";
import { PROVIDERS } from "@/integrations/mode";
import { act, bool, optStr, str, type ActionResult } from "@/server/action";
import { audit } from "@/server/audit";
import { requireAdminAction } from "./guard";
import { ROLES, type MemberRole } from "./roles";

const json = (v: unknown) => v as Prisma.InputJsonValue;
const ADMIN_PATHS = ["/admin", "/admin/users"];

const CompanyInput = z.object({
  name: z.string().trim().min(2, "Enter the company name.").max(120),
  slug: z
    .string()
    .trim()
    .min(2, "The short name needs at least two characters.")
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens for the short name."),
  currency: z.string().trim().length(3, "Use a three-letter currency code, for example USD.").toUpperCase(),
});

export async function createCompanyAction(_prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const admin = await requireAdminAction();
      const input = CompanyInput.parse({ name: str(fd, "name"), slug: str(fd, "slug").toLowerCase(), currency: str(fd, "currency") || "USD" });
      if (await unscopedDb.company.findUnique({ where: { slug: input.slug } })) throw new Error(`The short name "${input.slug}" is already in use.`);
      const s = defaultSettings();
      // Same shape as createCompany in prisma/seed.ts: settings from defaults and one connection row per integration.
      const company = await unscopedDb.$transaction(async (tx) => {
        const c = await tx.company.create({ data: { name: input.name, slug: input.slug, currency: input.currency } });
        await tx.settings.create({ data: { companyId: c.id, weights: json(s.weights), maxActiveSegments: s.maxActiveSegments, testDefaults: json(s.testDefaults), funnelDefaults: json(s.funnelDefaults), sequence: json(s.sequence), scorecard: json(s.scorecard) } });
        await tx.integrationConnection.createMany({ data: PROVIDERS.map((provider) => ({ companyId: c.id, provider, status: "connected", note: "Mock data" })) });
        return c;
      });
      await audit(scopedDb(company.id), company.id, { userId: admin.id, action: "company.create", entity: "company", entityId: company.id, data: input });
      return company.id;
    },
    { revalidate: ADMIN_PATHS, message: "Company created." },
  );
}

const UserInput = z.object({
  name: z.string().trim().min(2, "Enter the person's name.").max(120),
  email: z.email("Enter a valid email address."),
  isAdmin: z.boolean(),
});

export async function createUserAction(_prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const admin = await requireAdminAction();
      const input = UserInput.parse({ name: str(fd, "name"), email: str(fd, "email").toLowerCase(), isAdmin: bool(fd, "isAdmin") });
      if (await unscopedDb.user.findUnique({ where: { email: input.email } })) throw new Error(`${input.email} already has an account.`);
      const companyId = optStr(fd, "companyId");
      const role = optStr(fd, "role") ?? "OPERATOR";
      if (companyId && !(ROLES as readonly string[]).includes(role)) throw new Error("Pick a role.");
      const company = companyId ? await unscopedDb.company.findUnique({ where: { id: companyId } }) : null;
      if (companyId && !company) throw new Error("That company no longer exists.");
      const user = await unscopedDb.user.create({ data: input });
      if (company) {
        await unscopedDb.membership.create({ data: { companyId: company.id, userId: user.id, role: role as MemberRole } });
        await audit(scopedDb(company.id), company.id, { userId: admin.id, action: "membership.add", entity: "user", entityId: user.id, data: { email: user.email, role } });
      }
      return user.id;
    },
    { revalidate: ADMIN_PATHS, message: "Person added." },
  );
}

const MembershipInput = z.object({ userId: z.string().min(1, "Pick a person."), companyId: z.string().min(1, "Pick a company."), role: z.enum(ROLES, "Pick a role.") });

export async function addMembershipAction(_prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const admin = await requireAdminAction();
      const input = MembershipInput.parse({ userId: str(fd, "userId"), companyId: str(fd, "companyId"), role: str(fd, "role") });
      const [user, company] = await Promise.all([unscopedDb.user.findUnique({ where: { id: input.userId } }), unscopedDb.company.findUnique({ where: { id: input.companyId } })]);
      if (!user || !company) throw new Error("That person or company no longer exists.");
      const existing = await unscopedDb.membership.findUnique({ where: { companyId_userId: { companyId: company.id, userId: user.id } } });
      if (existing) throw new Error(`${user.name} is already in ${company.name}. Change the role instead.`);
      await unscopedDb.membership.create({ data: input });
      await audit(scopedDb(company.id), company.id, { userId: admin.id, action: "membership.add", entity: "user", entityId: user.id, data: { email: user.email, role: input.role } });
    },
    { revalidate: ADMIN_PATHS, message: "Access added." },
  );
}

async function ownersLeft(companyId: string, excludingId: string) {
  return unscopedDb.membership.count({ where: { companyId, role: "OWNER", id: { not: excludingId } } });
}

export async function changeRoleAction(membershipId: string, _prev: ActionResult | null, fd: FormData) {
  return act(
    async () => {
      const admin = await requireAdminAction();
      const role = z.enum(ROLES, "Pick a role.").parse(str(fd, "role"));
      const m = await unscopedDb.membership.findUniqueOrThrow({ where: { id: membershipId }, include: { user: true, company: true } });
      if (m.role === role) return;
      if (m.role === "OWNER" && (await ownersLeft(m.companyId, m.id)) === 0) throw new Error(`${m.user.name} is the only owner of ${m.company.name}. Make someone else owner first.`);
      await unscopedDb.membership.update({ where: { id: m.id }, data: { role } });
      await audit(scopedDb(m.companyId), m.companyId, { userId: admin.id, action: "membership.role", entity: "user", entityId: m.userId, data: { from: m.role, to: role } });
    },
    { revalidate: ADMIN_PATHS, message: "Role changed." },
  );
}

export async function removeMembershipAction(membershipId: string, _prev: ActionResult | null, _fd: FormData) {
  return act(
    async () => {
      const admin = await requireAdminAction();
      const m = await unscopedDb.membership.findUniqueOrThrow({ where: { id: membershipId }, include: { user: true, company: true } });
      if (m.role === "OWNER" && (await ownersLeft(m.companyId, m.id)) === 0) throw new Error(`${m.user.name} is the only owner of ${m.company.name}. Make someone else owner first.`);
      await unscopedDb.membership.delete({ where: { id: m.id } });
      await audit(scopedDb(m.companyId), m.companyId, { userId: admin.id, action: "membership.remove", entity: "user", entityId: m.userId, data: { email: m.user.email, role: m.role } });
    },
    { revalidate: ADMIN_PATHS },
  );
}
