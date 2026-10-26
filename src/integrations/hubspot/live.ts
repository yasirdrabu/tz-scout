// Live HubSpot over the CRM v3/v4 REST API with a private app token.
// Scopes used: companies, contacts and deals read/write (notes and tasks ride on these),
// company schema write (our properties), and owners read (team roster; optional).

import { createHash } from "node:crypto";
import { NotConnectedError, requireEnv } from "../mode";
import type { CompanyWrite, ContactWrite, CrmCompany, FollowThrough, HubSpotAdapter, HubSpotOwner, WonDeal } from "./index";
import { PROPERTY_GROUP, TAAZAA_PROPERTIES, TAAZAA_PROPERTY_NAMES } from "./properties";

const BASE = "https://api.hubapi.com";

// HubSpot-defined association type ids.
const ASSOC = { noteToCompany: 190, noteToContact: 202, taskToCompany: 192, taskToContact: 204, contactToCompany: 279 } as const;

/** Fingerprint of a note body, to tell whether someone edited it in HubSpot since our last push. */
export function noteHash(body: string): string {
  return createHash("sha1").update(body.replace(/\s+/g, " ").trim()).digest("hex");
}

export class HubSpotError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HubSpotError";
  }
}

type Fetch = typeof fetch;

export function createLive(fetchImpl: Fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): HubSpotAdapter {
  const call = async <T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> => {
    const { HUBSPOT_PRIVATE_APP_TOKEN: token } = requireEnv("hubspot", "HUBSPOT_PRIVATE_APP_TOKEN");
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 4) {
      await sleep(Number(res.headers.get("Retry-After") ?? 0) * 1000 || 1000 * (attempt + 1));
      return call<T>(method, path, body, attempt + 1);
    }
    if (res.status === 401) throw new NotConnectedError("hubspot", "HubSpot rejected the token");
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const msg = String(json.message ?? res.statusText);
      if (res.status === 403) throw new HubSpotError(403, `HubSpot needs another permission on the private app: ${msg}`);
      throw new HubSpotError(res.status, `HubSpot ${method} ${path.split("?")[0]} failed (${res.status}): ${msg}`);
    }
    return json as T;
  };

  type Obj = { id: string; properties: Record<string, string | null> };
  const search = (object: string, filters: { propertyName: string; operator: string; value: string }[], properties: string[]) =>
    call<{ results: Obj[] }>("POST", `/crm/v3/objects/${object}/search`, { filterGroups: [{ filters }], properties, limit: 1 }).then((r) => r.results[0] ?? null);
  const associate = (from: string, fromId: string, to: string, toId: string) => call("PUT", `/crm/v4/objects/${from}/${fromId}/associations/default/${to}/${toId}`);
  const clean = (o: Record<string, string | number | null | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));

  const findCompany = async (domain: string): Promise<CrmCompany | null> => {
    const c = await search("companies", [{ propertyName: "domain", operator: "EQ", value: domain }], ["name", "domain", "hubspot_owner_id", "lifecyclestage", "num_associated_deals", "hs_num_open_deals"]);
    if (!c) return null;
    const p = c.properties;
    return { id: c.id, name: p.name ?? null, ownerId: p.hubspot_owner_id || null, lifecycle: p.lifecyclestage || null, deals: Number(p.num_associated_deals ?? 0) || 0, openDeals: Number(p.hs_num_open_deals ?? 0) || 0 };
  };

  return {
    mode: "live",
    async lookupExisting(domain) {
      const c = await findCompany(domain);
      if (!c) return { existingCustomer: false, openDeal: false };
      return { existingCustomer: c.lifecycle === "customer", openDeal: c.openDeals > 0, detail: c.name ?? undefined };
    },
    async upsertContact(lead) {
      const { contactId } = await this.pushContact({ email: lead.email, firstName: lead.firstName, lastName: lead.lastName, title: lead.title });
      return { contactId };
    },
    async writeValidation() {
      throw new NotConnectedError("hubspot", "writing lead validation to HubSpot is scheduled for milestone 8");
    },
    async logMeeting() {
      throw new NotConnectedError("hubspot", "logging meetings to HubSpot is scheduled for milestone 8");
    },
    async listDeals() {
      throw new NotConnectedError("hubspot", "reading deals from HubSpot is scheduled for milestone 8");
    },
    findCompany,
    async upsertCompany(c: CompanyWrite) {
      const existing = await findCompany(c.domain);
      const ours = c.props ?? {};
      if (existing) {
        // Fill gaps and refresh our own fields; never take a company from the owner it already has.
        const mayOwn = !existing.ownerId || (!!c.ourOwnerId && existing.ownerId === c.ourOwnerId);
        const props = clean({ ...ours, ...(mayOwn ? { hubspot_owner_id: c.ownerId } : {}) });
        if (Object.keys(props).length) await call("PATCH", `/crm/v3/objects/companies/${existing.id}`, { properties: props });
        return { companyId: existing.id, created: false, ownerId: mayOwn ? (c.ownerId ?? existing.ownerId) : existing.ownerId };
      }
      const props = clean({
        name: c.name,
        domain: c.domain,
        website: c.website,
        city: c.city,
        state: c.state,
        country: c.country,
        numberofemployees: c.employees,
        description: c.description,
        hubspot_owner_id: c.ownerId,
        ...ours,
      });
      const created = await call<Obj>("POST", "/crm/v3/objects/companies", { properties: props });
      return { companyId: created.id, created: true, ownerId: c.ownerId ?? null };
    },
    async pushContact(c: ContactWrite) {
      let id = c.hubspotContactId ?? null;
      let owner: string | null = null;
      // Find them first: by email, or (researched people with no email yet) by name at the same company.
      const filters = c.email
        ? [{ propertyName: "email", operator: "EQ", value: c.email }]
        : c.lastName && c.companyId
          ? [
              { propertyName: "firstname", operator: "EQ", value: c.firstName },
              { propertyName: "lastname", operator: "EQ", value: c.lastName },
              { propertyName: "associatedcompanyid", operator: "EQ", value: c.companyId },
            ]
          : null;
      if (!id && filters) {
        const found = await search("contacts", filters, ["hubspot_owner_id"]);
        if (found) {
          id = found.id;
          owner = found.properties.hubspot_owner_id || null;
        }
      }
      const props = clean({ email: c.email, firstname: c.firstName, lastname: c.lastName, jobtitle: c.title, phone: c.phone, mobilephone: c.mobilePhone, hs_linkedin_url: c.linkedinUrl });
      if (id) {
        // Same rule as companies: keep an owner that's already set.
        if (c.ownerId && (c.takeOverOwner || (!owner && !c.hubspotContactId))) props.hubspot_owner_id = c.ownerId;
        await call("PATCH", `/crm/v3/objects/contacts/${id}`, { properties: props });
      } else {
        if (c.ownerId) props.hubspot_owner_id = c.ownerId;
        id = (await call<Obj>("POST", "/crm/v3/objects/contacts", { properties: props })).id;
      }
      if (c.companyId) await associate("contacts", id, "companies", c.companyId);
      return { contactId: id };
    },
    async upsertNote(n) {
      const stored = async (id: string) => (await call<Obj>("GET", `/crm/v3/objects/notes/${id}?properties=hs_note_body`).catch(() => null))?.properties.hs_note_body ?? null;
      if (n.noteId) {
        const current = await stored(n.noteId);
        // Update in place only when the note is still exactly what we last wrote (or we have no record of it).
        const untouched = current != null && (!n.expectedHash || noteHash(current) === n.expectedHash);
        if (untouched) {
          await call("PATCH", `/crm/v3/objects/notes/${n.noteId}`, { properties: { hs_note_body: n.html, hs_timestamp: new Date().toISOString() } });
          for (const cid of n.contactIds) await associate("notes", n.noteId, "contacts", cid);
          return { noteId: n.noteId, bodyHash: noteHash((await stored(n.noteId)) ?? n.html), kept: false };
        }
      }
      const associations = [
        { to: { id: n.companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC.noteToCompany }] },
        ...n.contactIds.map((id) => ({ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC.noteToContact }] })),
      ];
      const created = await call<Obj>("POST", "/crm/v3/objects/notes", { properties: clean({ hs_note_body: n.html, hs_timestamp: new Date().toISOString(), hubspot_owner_id: n.ownerId }), associations });
      // kept: an earlier note existed but had been edited in HubSpot, so it was left as is.
      return { noteId: created.id, bodyHash: noteHash((await stored(created.id)) ?? n.html), kept: !!n.noteId };
    },
    async upsertTask(t) {
      const props = clean({ hs_task_subject: t.subject, hs_task_body: t.body, hubspot_owner_id: t.ownerId, hs_timestamp: (t.dueAt ?? new Date(Date.now() + 86400_000)).toISOString() });
      if (t.taskId) {
        const existing = await call<Obj>("GET", `/crm/v3/objects/tasks/${t.taskId}?properties=hs_task_status`).catch(() => null);
        if (existing && existing.properties.hs_task_status !== "COMPLETED") {
          await call("PATCH", `/crm/v3/objects/tasks/${t.taskId}`, { properties: props });
          return { taskId: t.taskId };
        }
      }
      const associations = [
        ...(t.companyId ? [{ to: { id: t.companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC.taskToCompany }] }] : []),
        ...(t.contactId ? [{ to: { id: t.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOC.taskToContact }] }] : []),
      ];
      const created = await call<Obj>("POST", "/crm/v3/objects/tasks", { properties: { ...props, hs_task_status: "NOT_STARTED", hs_task_priority: "HIGH", hs_task_type: "TODO" }, associations });
      return { taskId: created.id };
    },
    async listOwners() {
      const out: HubSpotOwner[] = [];
      let after: string | undefined;
      do {
        const r = await call<{ results: { id: string; firstName?: string; lastName?: string; email?: string; archived?: boolean }[]; paging?: { next?: { after: string } } }>("GET", `/crm/v3/owners?limit=100${after ? `&after=${after}` : ""}`);
        for (const o of r.results) out.push({ id: o.id, name: [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || o.id, email: o.email ?? null, active: !o.archived });
        after = r.paging?.next?.after;
      } while (after);
      return out;
    },
    async followThrough(companyId: string, taskIds: string[]): Promise<FollowThrough> {
      const c = await call<Obj & { associations?: Record<string, { results: { id: string }[] }> }>("GET", `/crm/v3/objects/companies/${companyId}?properties=lifecyclestage,hubspot_owner_id,hs_last_sales_activity_timestamp,notes_last_contacted,hs_num_open_deals&associations=emails,calls,meetings,deals`);
      const n = (k: string) => c.associations?.[k]?.results?.length ?? 0;
      const tasks = taskIds.length ? (await call<{ results: Obj[] }>("POST", "/crm/v3/objects/tasks/batch/read", { inputs: taskIds.map((id) => ({ id })), properties: ["hs_task_status", "hs_timestamp"] })).results : [];
      const p = c.properties;
      return {
        tasks: tasks.map((t) => ({ id: t.id, status: t.properties.hs_task_status ?? "NOT_STARTED", dueAt: t.properties.hs_timestamp ?? null })),
        emails: n("emails"),
        calls: n("calls"),
        meetings: n("meetings"),
        deals: n("deals"),
        openDeals: Number(p.hs_num_open_deals ?? 0) || 0,
        stage: p.lifecyclestage ?? null,
        ownerId: p.hubspot_owner_id ?? null,
        lastActivityAt: p.hs_last_sales_activity_timestamp || p.notes_last_contacted || null,
      };
    },
    async listWonDeals(limit = 200) {
      const deals: Obj[] = [];
      let after: string | undefined;
      do {
        const r = await call<{ results: Obj[]; paging?: { next?: { after: string } } }>("POST", "/crm/v3/objects/deals/search", {
          filterGroups: [{ filters: [{ propertyName: "hs_is_closed_won", operator: "EQ", value: "true" }] }],
          properties: ["dealname", "amount", "closedate", "createdate", "description", "dealtype", "hs_analytics_source"],
          sorts: [{ propertyName: "closedate", direction: "DESCENDING" }],
          limit: 100,
          ...(after ? { after } : {}),
        });
        deals.push(...r.results);
        after = r.paging?.next?.after;
      } while (after && deals.length < limit);
      const picked = deals.slice(0, limit);
      if (!picked.length) return [];
      // Associations: deal to companies and contacts, then the records in batches.
      const assoc = async (to: string) => {
        const r = await call<{ results: { from: { id: string }; to: { toObjectId: number | string }[] }[] }>("POST", `/crm/v4/associations/deals/${to}/batch/read`, { inputs: picked.map((d) => ({ id: d.id })) });
        return new Map(r.results.map((x) => [String(x.from.id), x.to.map((t) => String(t.toObjectId))]));
      };
      const [toCompanies, toContacts] = await Promise.all([assoc("companies"), assoc("contacts")]);
      const read = async (object: string, ids: string[], properties: string[]) => {
        const out = new Map<string, Record<string, string | null>>();
        for (let i = 0; i < ids.length; i += 100) {
          const r = await call<{ results: Obj[] }>("POST", `/crm/v3/objects/${object}/batch/read`, { inputs: ids.slice(i, i + 100).map((id) => ({ id })), properties });
          for (const o of r.results) out.set(o.id, o.properties);
        }
        return out;
      };
      const companyIds = [...new Set([...toCompanies.values()].flat())];
      const contactIds = [...new Set([...toContacts.values()].flat())];
      const [companies, contacts] = await Promise.all([
        read("companies", companyIds, ["name", "domain", "industry", "numberofemployees", "annualrevenue", "state", "country"]),
        read("contacts", contactIds, ["jobtitle"]),
      ]);
      const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));
      return picked.map((d): WonDeal => {
        const p = d.properties;
        const c = companies.get(toCompanies.get(d.id)?.[0] ?? "");
        const amount = num(p.amount);
        const revenue = num(c?.annualrevenue);
        return {
          id: d.id,
          name: p.dealname ?? "Deal",
          amountCents: amount == null || Number.isNaN(amount) ? null : Math.round(amount * 100),
          closedAt: p.closedate ?? null,
          createdAt: p.createdate ?? null,
          description: p.description ?? null,
          dealType: p.dealtype ?? null,
          source: p.hs_analytics_source ?? null,
          company: c ? { name: c.name ?? null, domain: c.domain ?? null, industry: c.industry ?? null, employees: num(c.numberofemployees), revenueCents: revenue == null || Number.isNaN(revenue) ? null : Math.round(revenue * 100), state: c.state ?? null, country: c.country ?? null } : null,
          buyerTitles: (toContacts.get(d.id) ?? []).map((id) => contacts.get(id)?.jobtitle ?? null).filter((t): t is string => !!t),
        };
      });
    },
    async existingProperties() {
      const r = await call<{ results: { name: string }[] }>("GET", "/crm/v3/properties/companies");
      const names = new Set(r.results.map((p) => p.name));
      return new Set(TAAZAA_PROPERTY_NAMES.filter((n) => names.has(n)));
    },
    async createProperties() {
      const have = await this.existingProperties();
      const groups = await call<{ results: { name: string }[] }>("GET", "/crm/v3/properties/companies/groups");
      if (!groups.results.some((g) => g.name === PROPERTY_GROUP.name)) await call("POST", "/crm/v3/properties/companies/groups", { name: PROPERTY_GROUP.name, label: PROPERTY_GROUP.label });
      const made: string[] = [];
      for (const p of TAAZAA_PROPERTIES) {
        if (have.has(p.name)) continue;
        await call("POST", "/crm/v3/properties/companies", {
          name: p.name,
          label: p.label,
          type: p.type,
          fieldType: p.fieldType,
          groupName: PROPERTY_GROUP.name,
          description: p.description,
          ...(p.options ? { options: p.options.map((o, i) => ({ label: o, value: o, displayOrder: i })) } : {}),
        });
        made.push(p.name);
      }
      return made;
    },
  };
}
