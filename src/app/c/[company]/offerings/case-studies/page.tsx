import { getCompanyContext } from "@/server/context";
import { Card, EmptyState, PageHeader, Table, Tabs, Td, Th } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { CaseStudyDialog } from "./dialog";
import { deleteCaseStudyAction, saveCaseStudyAction } from "../actions";

export const metadata = { title: "Case studies" };

export default async function CaseStudies({ params }: { params: Promise<{ company: string }> }) {
  const { company: slug } = await params;
  const ctx = await getCompanyContext(slug);
  const cases = await ctx.db.caseStudy.findMany({ orderBy: { client: "asc" }, include: { offerings: { include: { offering: { select: { name: true } } } } } });
  const offeringCount = await ctx.db.offering.count({ where: { status: { not: "ARCHIVED" } } });
  const canEdit = ctx.can("offering.edit");

  return (
    <>
      <PageHeader
        title="Offerings"
        description="Case studies are their own records and can back many offerings. Segment scoring counts matches by industry."
        actions={canEdit && <CaseStudyDialog action={saveCaseStudyAction.bind(null, slug, null)} trigger="New case study" />}
      />
      <Tabs
        current="cases"
        items={[
          { key: "offerings", label: "Offerings", href: `/c/${slug}/offerings`, count: offeringCount },
          { key: "cases", label: "Case studies", href: `/c/${slug}/offerings/case-studies`, count: cases.length },
        ]}
      />
      {cases.length === 0 ? (
        <EmptyState title="No case studies yet">Add the results you can point to. They count as proof when scoring segments and go out in pre-call notes.</EmptyState>
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Client</Th>
                <Th>Title</Th>
                <Th>Industry</Th>
                <Th>Result</Th>
                <Th>Offerings</Th>
                {canEdit && <Th />}
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">
                    {c.link ? (
                      <a href={c.link} target="_blank" rel="noreferrer" className="link">
                        {c.client}
                      </a>
                    ) : (
                      c.client
                    )}
                  </Td>
                  <Td className="max-w-[220px]">{c.title}</Td>
                  <Td className="whitespace-nowrap text-ink-soft">{c.industry}</Td>
                  <Td className="max-w-sm text-ink-soft">{c.result}</Td>
                  <Td className="text-xs text-ink-muted">{c.offerings.map((o) => o.offering.name).join(", ") || "None"}</Td>
                  {canEdit && (
                    <Td className="whitespace-nowrap text-right">
                      <div className="flex justify-end gap-1">
                        <CaseStudyDialog action={saveCaseStudyAction.bind(null, slug, c.id)} trigger="Edit" initial={c} />
                        <ActionButton action={deleteCaseStudyAction.bind(null, slug, c.id)} variant="ghost" size="sm" confirm={`Delete the ${c.client} case study?`}>
                          Delete
                        </ActionButton>
                      </div>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
