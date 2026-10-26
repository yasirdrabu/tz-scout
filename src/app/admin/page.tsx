import Link from "next/link";
import { unscopedDb } from "@/lib/db";
import { date } from "@/lib/format";
import { Card, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireAdminPage } from "./guard";
import { NewCompanyDialog } from "./forms";

export const metadata = { title: "Companies" };

export default async function AdminCompaniesPage() {
  await requireAdminPage();
  const companies = await unscopedDb.company.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { memberships: true, offerings: true, leads: true } } },
  });

  return (
    <>
      <PageHeader title="Companies" description="Every company using the system. Each one's data is kept apart from the others." actions={<NewCompanyDialog />} />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Company</Th>
              <Th>Short name</Th>
              <Th>Currency</Th>
              <Th numeric>People</Th>
              <Th numeric>Offerings</Th>
              <Th numeric>Leads</Th>
              <Th numeric>Created</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <tr key={c.id} className="hover:bg-sunken/50">
                <Td className="font-medium">{c.name}</Td>
                <Td className="font-mono text-xs text-ink-soft">{c.slug}</Td>
                <Td className="text-ink-soft">{c.currency}</Td>
                <Td numeric>
                  <Link href="/admin/users" className="link">
                    {c._count.memberships}
                  </Link>
                </Td>
                <Td numeric>{c._count.offerings}</Td>
                <Td numeric>{c._count.leads}</Td>
                <Td numeric className="text-ink-muted">
                  {date(c.createdAt, { month: "short", day: "numeric", year: "numeric" })}
                </Td>
                <Td className="text-right">
                  <Link href={`/c/${c.slug}/scorecard`} className="link text-xs">
                    Open
                  </Link>
                  <span className="text-ink-faint"> · </span>
                  <Link href={`/c/${c.slug}/settings?tab=integrations`} className="link text-xs">
                    Integrations
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
