import Link from "next/link";
import { getCompanyContext } from "@/server/context";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { relative } from "@/lib/format";
import { modeOf } from "@/integrations/mode";
import type { ImportStats } from "@/server/leadImport";
import { dropImportAction } from "./actions";
import { DropZone } from "./dropzone";

export const metadata = { title: "Import" };

export default async function ImportPage({ params }: { params: Promise<{ company: string }> }) {
  const { company: slug } = await params;
  const ctx = await getCompanyContext(slug);
  const canAct = ctx.can("buyers.act");
  const [imports, buckets] = await Promise.all([
    ctx.db.leadImport.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true, fileName: true, status: true, kind: true, bucketId: true, stats: true, createdBy: true, createdAt: true } }),
    ctx.db.bucket.findMany({ orderBy: { sort: "asc" }, select: { id: true, name: true } }),
  ]);
  const bucketName = new Map(buckets.map((b) => [b.id, b.name]));

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/c/${slug}/buyers`} className="hover:text-ink">
            Buyers
          </Link>
        }
        title="Import"
        description="Drop in research sheets or lead lists. Each file is read, filed into its bucket, matched against the accounts we already have and against HubSpot, then scored. Research keeps everything: the signal and its source, the decision-makers, the hook, the proposed pilot and the researcher's score."
      />

      {canAct && (
        <Card className="mb-5 p-5">
          <DropZone action={dropImportAction.bind(null, slug)} slug={slug} buckets={buckets} canEnrich={modeOf("prospects") === "live"} />
          <p className="mt-3 text-xs text-ink-muted">
            Research sheets are recognised by their columns and go straight in. A plain lead list goes straight in when it has a website or work-email column; otherwise you&apos;re asked which column is which. Companies without a website are held for you to add one. Nothing is pushed to HubSpot from here.
          </p>
        </Card>
      )}

      {imports.length === 0 ? (
        <EmptyState title="Nothing imported yet">Imported files show here with what each one added.</EmptyState>
      ) : (
        <Card>
          <CardHeader title="Imported files" />
          <Table>
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Bucket</Th>
                <Th>Status</Th>
                <Th numeric>Companies</Th>
                <Th numeric>New</Th>
                <Th numeric>People added</Th>
                <Th numeric>Act now</Th>
                <Th numeric>Held</Th>
                <Th>Added</Th>
              </tr>
            </thead>
            <tbody>
              {imports.map((i) => {
                const s = i.stats as ImportStats | null;
                const held = s?.skipped.length ?? 0;
                return (
                  <tr key={i.id} className="hover:bg-sunken/50">
                    <Td>
                      <Link href={`/c/${slug}/buyers/import/${i.id}`} className="font-medium text-ink hover:text-accent">
                        {i.name}
                      </Link>
                      <div className="text-2xs text-ink-muted">
                        {i.kind === "research" ? "Research sheet" : "Lead list"} · {i.fileName}
                      </div>
                    </Td>
                    <Td className="text-ink-soft">{i.bucketId ? (bucketName.get(i.bucketId) ?? "n/a") : <span className="text-ink-muted">None</span>}</Td>
                    <Td>{i.status === "done" ? <Badge tone="good">Imported</Badge> : i.status === "error" ? <Badge tone="bad">Failed</Badge> : <Badge tone="near">Check columns</Badge>}</Td>
                    <Td numeric className="tnum">{s?.companies ?? "n/a"}</Td>
                    <Td numeric className="tnum">{s?.created ?? "n/a"}</Td>
                    <Td numeric className="tnum">{s?.peopleAdded ?? "n/a"}</Td>
                    <Td numeric className="tnum">{s ? (s.tiers.act_now ?? 0) : "n/a"}</Td>
                    <Td numeric className={`tnum ${held ? "text-near" : ""}`}>{s ? held : "n/a"}</Td>
                    <Td className="whitespace-nowrap text-xs text-ink-soft">
                      {relative(i.createdAt)}
                      {i.createdBy ? ` by ${i.createdBy}` : ""}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
