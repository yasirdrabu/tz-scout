// Download a segment's winners in three shapes: ad copy, landing page headlines and discovery call
// questions. Plain text by default, ?format=csv for a spreadsheet. Scoped to the signed-in company.

import { getCompanyContext } from "@/server/context";
import { exportWinners, library } from "@/server/tests";

const csvCell = (s: string) => `"${s.replace(/"/g, '""')}"`;

export async function GET(req: Request, { params }: { params: Promise<{ company: string }> }) {
  const { company: slug } = await params;
  const ctx = await getCompanyContext(slug);
  const url = new URL(req.url);
  const segmentId = url.searchParams.get("segment");
  const format = url.searchParams.get("format") === "csv" ? "csv" : "txt";
  const seg = segmentId ? await ctx.db.segment.findUnique({ where: { id: segmentId }, include: { offering: { select: { name: true } } } }) : null;
  if (!seg) return new Response("Segment not found.", { status: 404 });

  const rows = await library(ctx.db, { segmentId: seg.id });
  const ex = exportWinners(rows);
  const sections: [string, string[]][] = [
    ["Ad copy", ex.adCopy],
    ["Landing page headlines", ex.headlines],
    ["Discovery call questions", ex.discoveryQuestions],
  ];
  const stamp = new Date().toISOString().slice(0, 10);
  const file = `winners-${seg.key}-${stamp}.${format}`;

  let body: string;
  if (format === "csv") {
    body = ["Use,Text", ...sections.flatMap(([use, items]) => items.map((t) => `${csvCell(use)},${csvCell(t)}`))].join("\r\n") + "\r\n";
  } else {
    const lines = [`Winning statements for ${seg.buyer}`, `${seg.offering.name}. ${rows.length} ${rows.length === 1 ? "winner" : "winners"}, exported ${stamp}.`, ""];
    for (const [title, items] of sections) {
      lines.push(title, "-".repeat(title.length));
      lines.push(...(items.length ? items.map((t) => `- ${t}`) : ["(none yet)"]), "");
    }
    body = lines.join("\n");
  }

  return new Response(body, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "no-store",
    },
  });
}
