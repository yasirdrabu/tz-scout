// Request context for company pages and actions: who is signed in, which company, their role,
// and a database client scoped to that company.

import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { currentUser, type SessionUser } from "@/lib/auth";
import { scopedDb, unscopedDb, type ScopedDb } from "@/lib/db";
import { can, type Action, type AppRole } from "@/lib/permissions";

export type CompanyContext = {
  user: SessionUser;
  company: { id: string; slug: string; name: string; currency: string };
  role: AppRole;
  db: ScopedDb;
  can: (a: Action) => boolean;
};

export const requireUser = cache(async (): Promise<SessionUser> => {
  const user = await currentUser();
  if (!user) redirect("/signin");
  return user;
});

export const getCompanyContext = cache(async (slug: string): Promise<CompanyContext> => {
  const user = await requireUser();
  const company = await unscopedDb.company.findUnique({ where: { slug } });
  if (!company) notFound();
  const membership = await unscopedDb.membership.findUnique({ where: { companyId_userId: { companyId: company.id, userId: user.id } } });
  if (!membership && !user.isAdmin) notFound();
  const role: AppRole = user.isAdmin ? "ADMIN" : membership!.role;
  return {
    user,
    company: { id: company.id, slug: company.slug, name: company.name, currency: company.currency },
    role,
    db: scopedDb(company.id),
    can: (a) => can(role, a),
  };
});

export class ForbiddenError extends Error {
  constructor(action: string) {
    super(`You don't have permission to ${action.replace(".", " ")}.`);
    this.name = "ForbiddenError";
  }
}

/** For server actions: resolve context and enforce one permission. */
export async function authorize(slug: string, action: Action): Promise<CompanyContext> {
  const ctx = await getCompanyContext(slug);
  if (!ctx.can(action)) throw new ForbiddenError(action);
  return ctx;
}

/** Companies the user can switch between. */
export async function companiesFor(user: SessionUser) {
  if (user.isAdmin) return unscopedDb.company.findMany({ orderBy: { name: "asc" }, select: { slug: true, name: true } });
  const ms = await unscopedDb.membership.findMany({ where: { userId: user.id }, include: { company: { select: { slug: true, name: true } } }, orderBy: { company: { name: "asc" } } });
  return ms.map((m) => m.company);
}
