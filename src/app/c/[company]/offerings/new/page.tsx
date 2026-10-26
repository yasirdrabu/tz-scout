import { notFound } from "next/navigation";
import { getCompanyContext } from "@/server/context";
import { PageHeader } from "@/components/ui";
import { OfferingForm } from "../offering-form";
import { toFormValues } from "../values";
import { draftOfferingAction, saveOfferingAction } from "../actions";

export const metadata = { title: "New offering" };

export default async function NewOffering({ params }: { params: Promise<{ company: string }> }) {
  const { company: slug } = await params;
  const ctx = await getCompanyContext(slug);
  if (!ctx.can("offering.edit")) notFound();
  const caseStudies = await ctx.db.caseStudy.findMany({ orderBy: { client: "asc" }, select: { id: true, title: true, client: true, industry: true } });
  return (
    <>
      <PageHeader eyebrow="Offerings" title="New offering" description="Saved as a draft. An owner approves it before segments and tests can use it." />
      <OfferingForm
        initial={toFormValues(null)}
        saveAction={saveOfferingAction.bind(null, slug, null)}
        draftAction={draftOfferingAction.bind(null, slug, null)}
        caseStudies={caseStudies}
        canEdit
        redirectTo={`/c/${slug}/offerings/{id}`}
        submitLabel="Save draft"
      />
    </>
  );
}
