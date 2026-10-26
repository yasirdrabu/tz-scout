import { unscopedDb } from "@/lib/db";
import { anthropicAdapter } from "@/integrations/anthropic";
import { modeOf } from "@/integrations/mode";
import { dateTime, num } from "@/lib/format";
import { Badge, Card, CardHeader, KeyValue, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { requireAdminPage } from "../guard";

export const metadata = { title: "Claude" };

const TASK_LABEL: Record<string, string> = {
  segments: "Segments",
  statements: "Statements",
  rewrite: "Statement rewrite",
  "offering-draft": "Offering draft",
  "lead-research": "Lead research",
  "weekly-diagnosis": "Weekly diagnosis",
};

export default async function AdminAiPage() {
  await requireAdminPage();
  const adapter = anthropicAdapter();
  const mode = modeOf("anthropic");
  const runs = await unscopedDb.aiRun.findMany({ orderBy: { createdAt: "desc" }, take: 50, include: { company: { select: { name: true } } } });

  return (
    <>
      <PageHeader title="Claude" description="Which model the system uses, and a log of every call across companies." />
      <div className="mb-5 grid gap-5 md:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader title="Current setup" />
          <div className="p-4">
            <KeyValue
              items={[
                ["Mode", mode === "live" ? <Badge tone="good">Live</Badge> : <Badge tone="near">Sample data</Badge>],
                ["Model", <span key="m" className="font-mono text-xs">{adapter.model}</span>],
                ["Calls shown", num(runs.length)],
              ]}
            />
          </div>
        </Card>
        {mode === "mock" ? (
          <Notice tone="near" title="Claude is on sample data">
            Every task still builds its prompt, checks the answer against its schema and logs the call, but the answer is a fixed sample. Set INTEGRATION_ANTHROPIC=live and an API key on the server to use the real model. The model can be changed with ANTHROPIC_MODEL.
          </Notice>
        ) : (
          <Notice tone="neutral" title="Claude is live">
            Calls go to the model shown. Change it with ANTHROPIC_MODEL on the server.
          </Notice>
        )}
      </div>

      <Card>
        <CardHeader title="Recent calls" description="The latest 50, newest first." />
        {runs.length === 0 ? (
          <p className="p-4 text-sm text-ink-muted">No calls yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Company</Th>
                <Th>Task</Th>
                <Th>Prompt</Th>
                <Th>Model</Th>
                <Th>Data</Th>
                <Th numeric>Tokens in</Th>
                <Th numeric>Tokens out</Th>
                <Th>Result</Th>
                <Th numeric>Took</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-ink-muted">{dateTime(r.createdAt)}</Td>
                  <Td>{r.company.name}</Td>
                  <Td>{TASK_LABEL[r.task] ?? r.task}</Td>
                  <Td className="font-mono text-xs text-ink-soft">{r.promptVersion}</Td>
                  <Td className="font-mono text-xs text-ink-soft">{r.model}</Td>
                  <Td>{r.mock ? <Badge tone="muted">Sample</Badge> : <Badge>Live</Badge>}</Td>
                  <Td numeric>{num(r.inputTokens)}</Td>
                  <Td numeric>{num(r.outputTokens)}</Td>
                  <Td>
                    {r.ok ? (
                      <Badge tone="good">Worked</Badge>
                    ) : (
                      <span title={r.error ?? undefined}>
                        <Badge tone="bad">Failed</Badge>
                        {r.error && <span className="ml-1.5 line-clamp-1 max-w-[240px] text-2xs text-bad">{r.error}</span>}
                      </span>
                    )}
                  </Td>
                  <Td numeric className="text-ink-muted">
                    {r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)} s` : `${(r.durationMs / 1000).toFixed(2)} s`}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
