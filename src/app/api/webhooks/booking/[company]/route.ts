// Inbound bookings from the scheduling tool.
//
// POST /api/webhooks/booking/<company-slug>
// Headers: content-type: application/json, x-webhook-secret: <WEBHOOK_SECRET>
// Body: { "leadId": "<lead id>", "scheduledAt": "2026-10-15T14:00:00Z", "type": "DISCOVERY" | "SALES" }
//   type is optional and defaults to DISCOVERY.
// Responses: 201 { meetingId } (confirmation, reminders and the pre-call note are scheduled),
// 400 { error } on bad input, 401 on a missing or wrong secret, 404 when the company or lead is unknown.

import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedDb } from "@/lib/db";
import { bookMeeting } from "@/server/meetings";
import { companyBySlug, readJson, secretOk, unauthorized } from "../../secret";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BookingInput = z.object({
  leadId: z.string().trim().min(1),
  scheduledAt: z.iso.datetime({ offset: true }),
  type: z.enum(["DISCOVERY", "SALES"]).default("DISCOVERY"),
});

export async function POST(req: Request, { params }: { params: Promise<{ company: string }> }) {
  if (!secretOk(req)) return unauthorized();
  const { company: slug } = await params;
  const company = await companyBySlug(slug);
  if (!company) return NextResponse.json({ error: "Unknown company." }, { status: 404 });

  const json = await readJson(req);
  if (!json.ok) return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  const parsed = BookingInput.safeParse(json.body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json({ error: i ? `${i.path.join(".") || "body"}: ${i.message}` : "Invalid booking." }, { status: 400 });
  }

  const db = scopedDb(company.id);
  const lead = await db.lead.findUnique({ where: { id: parsed.data.leadId }, select: { id: true } });
  if (!lead) return NextResponse.json({ error: "Unknown lead." }, { status: 404 });

  try {
    const meetingId = await bookMeeting(db, company.id, lead.id, new Date(parsed.data.scheduledAt), parsed.data.type);
    return NextResponse.json({ meetingId }, { status: 201 });
  } catch (e) {
    console.error("[webhook:booking]", e);
    return NextResponse.json({ error: "Could not book the meeting." }, { status: 500 });
  }
}
