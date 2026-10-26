// Inbound form submissions (website form or a HubSpot form webhook).
//
// POST /api/webhooks/form/<company-slug>
// Headers: content-type: application/json, x-webhook-secret: <WEBHOOK_SECRET>
// Body (FormSubmissionInput in src/server/leads.ts):
//   {
//     "email": "dana.reyes@keystone-ridge-properties.com",   required, a valid email
//     "firstName": "Dana",                                   required
//     "lastName": "Reyes",                                   optional, defaults to ""
//     "title": "Chief Operating Officer",                    optional
//     "company": "Keystone Ridge Properties",                optional
//     "phone": "+1 555 010 0142",                            optional
//     "smsConsent": true,                                    optional, defaults to false
//     "timeline": "3m",                                      optional: now | 3m | 6m | 12m | research
//     "offering": "ai-opportunity-map",                      optional, offering slug
//     "answers": { "anything": "else" }                      optional, other form answers
//   }
// Responses: 202 { leadId } (validation is queued and runs in the background), 400 { error } on bad
// input, 401 on a missing or wrong secret, 404 when the company slug is unknown.

import { NextResponse } from "next/server";
import { scopedDb } from "@/lib/db";
import { FormSubmissionInput, ingestSubmission } from "@/server/leads";
import { companyBySlug, readJson, secretOk, unauthorized } from "../../secret";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ company: string }> }) {
  if (!secretOk(req)) return unauthorized();
  const { company: slug } = await params;
  const company = await companyBySlug(slug);
  if (!company) return NextResponse.json({ error: "Unknown company." }, { status: 404 });

  const json = await readJson(req);
  if (!json.ok) return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  const parsed = FormSubmissionInput.safeParse(json.body);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return NextResponse.json({ error: i ? `${i.path.join(".") || "body"}: ${i.message}` : "Invalid submission." }, { status: 400 });
  }

  try {
    const leadId = await ingestSubmission(scopedDb(company.id), company.id, json.body, "webhook");
    return NextResponse.json({ leadId }, { status: 202 });
  } catch (e) {
    console.error("[webhook:form]", e);
    return NextResponse.json({ error: "Could not store the submission." }, { status: 500 });
  }
}
