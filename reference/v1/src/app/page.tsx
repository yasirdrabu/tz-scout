import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { companiesFor } from "@/server/context";
import { unscopedDb } from "@/lib/db";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/signin");
  const companies = await companiesFor(user);
  if (companies.length === 0) redirect("/signin?error=no_company");
  // Prefer the company the user belongs to over ones they only see as admin.
  const own = await unscopedDb.membership.findFirst({ where: { userId: user.id }, include: { company: true }, orderBy: { createdAt: "asc" } });
  const slug = own?.company.slug ?? companies[0]!.slug;
  redirect(`/c/${slug}/buyers`);
}
