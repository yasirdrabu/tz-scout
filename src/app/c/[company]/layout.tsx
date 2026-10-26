import Link from "next/link";
import { getCompanyContext, companiesFor } from "@/server/context";
import { NAV, ROLE_LABEL } from "@/lib/permissions";
import { PROVIDERS, modeOf } from "@/integrations/mode";
import { CompanySwitcher, NavLink, SignOutButton } from "./nav";

export default async function CompanyLayout({ children, params }: { children: React.ReactNode; params: Promise<{ company: string }> }) {
  const { company: slug } = await params;
  const ctx = await getCompanyContext(slug);
  const companies = await companiesFor(ctx.user);
  const nav = NAV.filter((n) => (n.roles as readonly string[]).includes(ctx.role));
  const mocks = PROVIDERS.filter((p) => modeOf(p) === "mock").length;
  const [reviewCount] = await Promise.all([ctx.db.lead.count({ where: { status: "REVIEW", overrideStatus: null } })]);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-surface print:hidden" data-chrome>
        <div className="border-b border-line p-3">
          <CompanySwitcher current={ctx.company.slug} companies={companies} />
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {nav.map((n, i) => (
            <div key={n.href}>
              {n.group !== (nav[i - 1]?.group ?? null) && (
                <div className={`px-2.5 pb-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint ${i === 0 ? "pt-1" : n.group ? "pt-4" : "mt-3 border-t border-line pt-3"}`}>{n.group}</div>
              )}
              <NavLink
                href={`/c/${slug}/${n.href}`}
                notUnder={nav.filter((x) => x.href !== n.href && x.href.startsWith(`${n.href}/`)).map((x) => `/c/${slug}/${x.href}`)}
                badge={n.href === "leads" && reviewCount > 0 ? reviewCount : undefined}
              >
                {n.label}
              </NavLink>
            </div>
          ))}
          {ctx.user.isAdmin && (
            <div className="mt-4 border-t border-line pt-3">
              <NavLink href="/admin">Admin</NavLink>
            </div>
          )}
        </nav>
        <div className="border-t border-line p-3">
          {mocks > 0 && (
            <Link href={`/c/${slug}/settings?tab=integrations`} className="mb-2 block rounded border border-near-line bg-near-soft px-2 py-1 text-2xs text-near">
              {mocks === PROVIDERS.length ? "All integrations on sample data" : `${mocks} integrations on sample data`}
            </Link>
          )}
          <div className="text-xs font-medium text-ink">{ctx.user.name}</div>
          <div className="flex items-center justify-between">
            <span className="text-2xs text-ink-muted">{ROLE_LABEL[ctx.role]}</span>
            <SignOutButton />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-6">{children}</main>
    </div>
  );
}
