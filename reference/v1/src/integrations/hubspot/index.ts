// HubSpot is the record for contacts, companies and deals. We keep our own objects plus the
// HubSpot ids that link back. The mock records every write to the audit log so it is inspectable.

import { modeOf } from "../mode";
import { MOCK_CRM } from "../companyData/fixtures";
import { hashString } from "@/lib/rand";
import { createLive, noteHash } from "./live";

export type ExistingLookup = { existingCustomer: boolean; openDeal: boolean; detail?: string; contactId?: string };

export type LeadWrite = {
  email: string;
  firstName: string;
  lastName: string;
  title?: string | null;
  companyName?: string | null;
  domain?: string | null;
};

/** A buyer contact pushed from Buyers. Email or phone may be missing until contacts are enriched. */
export type ContactWrite = {
  hubspotContactId?: string | null;
  email?: string | null;
  firstName: string;
  lastName?: string | null;
  title?: string | null;
  phone?: string | null;
  mobilePhone?: string | null;
  linkedinUrl?: string | null;
  ownerId?: string | null;
  /** Set the owner even if the contact already has one (we're taking the account over). */
  takeOverOwner?: boolean;
  companyId?: string | null;
};

export type ValidationWrite = {
  leadStatus: "VALIDATED" | "NOT_QUALIFIED" | "REVIEW";
  researchNote: string | null;
  checks: Record<string, { result: string; reason: string }>;
  ownerEmail: string | null;
  reason: string;
};

export type HubSpotDeal = { id: string; contactEmail?: string; stage: string; amountCents: number; qualifiedAt?: Date; closedAt?: Date; isWon: boolean };

/** What HubSpot already has for a company, found by domain. */
export type CrmCompany = { id: string; name: string | null; ownerId: string | null; lifecycle: string | null; deals: number; openDeals: number };

export type CompanyWrite = {
  domain: string;
  name: string;
  website?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  employees?: number | null;
  description?: string | null;
  ownerId?: string | null;
  /** The owner we set on an earlier push. Only that owner may be replaced; one set by someone else stays. */
  ourOwnerId?: string | null;
  /** Our own company properties (taazaa_*), written only once they exist in HubSpot. */
  props?: Record<string, string | number | null>;
};

export type HubSpotOwner = { id: string; name: string; email: string | null; active: boolean };

/** What has happened on a company since we pushed it: our tasks, and engagement counts. */
export type FollowThrough = {
  tasks: { id: string; status: string; dueAt: string | null }[];
  emails: number;
  calls: number;
  meetings: number;
  deals: number;
  openDeals: number;
  stage: string | null;
  ownerId: string | null;
  lastActivityAt: string | null;
};

/** A closed-won deal with the company and buyers behind it, for win analysis. */
export type WonDeal = {
  id: string;
  name: string;
  amountCents: number | null;
  closedAt: string | null;
  createdAt: string | null;
  description: string | null;
  dealType: string | null;
  source: string | null;
  company: { name: string | null; domain: string | null; industry: string | null; employees: number | null; revenueCents: number | null; state: string | null; country: string | null } | null;
  buyerTitles: string[];
};

export interface HubSpotAdapter {
  readonly mode: "mock" | "live";
  lookupExisting(domain: string, email: string): Promise<ExistingLookup>;
  upsertContact(lead: LeadWrite): Promise<{ contactId: string }>;
  writeValidation(contactId: string, v: ValidationWrite): Promise<void>;
  logMeeting(contactId: string, m: { type: string; status: string; scheduledAt: Date }): Promise<{ meetingId: string }>;
  listDeals(since: Date): Promise<HubSpotDeal[]>;
  // Buyers: check, push and keep updated.
  findCompany(domain: string): Promise<CrmCompany | null>;
  /** Create, or update the company found by domain. Never replaces an owner already set in HubSpot. */
  upsertCompany(c: CompanyWrite): Promise<{ companyId: string; created: boolean; ownerId: string | null }>;
  pushContact(c: ContactWrite): Promise<{ contactId: string }>;
  /**
   * Create the context note, or update it in place when noteId is given. If the note in HubSpot no
   * longer matches expectedHash (someone edited it), it's left alone and a new note is added.
   */
  upsertNote(n: { noteId?: string | null; expectedHash?: string | null; companyId: string; contactIds: string[]; html: string; ownerId?: string | null }): Promise<{ noteId: string; bodyHash: string; kept: boolean }>;
  upsertTask(t: { taskId?: string | null; companyId?: string | null; contactId?: string | null; subject: string; body: string; ownerId?: string | null; dueAt?: Date }): Promise<{ taskId: string }>;
  listOwners(): Promise<HubSpotOwner[]>;
  /** Read-only: closed-won deals, newest first, with company facts and buyer titles. */
  listWonDeals(limit?: number): Promise<WonDeal[]>;
  /** Read-only: our tasks' status and the company's engagement counts. */
  followThrough(companyId: string, taskIds: string[]): Promise<FollowThrough>;
  /** Our company properties that exist in HubSpot. */
  existingProperties(): Promise<Set<string>>;
  /** Create the "Taazaa buyer signals" property group and any missing properties. Changes HubSpot settings. */
  createProperties(): Promise<string[]>;
}

export type Recorder = (action: string, data: Record<string, unknown>) => Promise<void>;

function createMock(record: Recorder): HubSpotAdapter {
  const id = (prefix: string, s: string) => `${prefix}${hashString(s).toString(36)}`;
  return {
    mode: "mock",
    async lookupExisting(domain) {
      const customers = MOCK_CRM.customers as Record<string, string>;
      const open = MOCK_CRM.openDeals as Record<string, string>;
      if (customers[domain]) return { existingCustomer: true, openDeal: false, detail: customers[domain] };
      if (open[domain]) return { existingCustomer: false, openDeal: true, detail: open[domain] };
      return { existingCustomer: false, openDeal: false };
    },
    async upsertContact(lead) {
      const contactId = id("hs_c_", lead.email.toLowerCase());
      await record("hubspot.upsertContact", { contactId, email: lead.email });
      return { contactId };
    },
    async writeValidation(contactId, v) {
      await record("hubspot.writeValidation", { contactId, ...v });
    },
    async logMeeting(contactId, m) {
      const meetingId = id("hs_m_", contactId + m.scheduledAt.toISOString());
      await record("hubspot.logMeeting", { contactId, meetingId, ...m });
      return { meetingId };
    },
    async listDeals() {
      // Mock deals live in the DealLink cache written by the seed.
      return [];
    },
    async findCompany(domain) {
      const customers = MOCK_CRM.customers as Record<string, string>;
      const open = MOCK_CRM.openDeals as Record<string, string>;
      if (customers[domain]) return { id: id("hs_co_", domain), name: null, ownerId: "mock-owner", lifecycle: "customer", deals: 1, openDeals: 0 };
      if (open[domain]) return { id: id("hs_co_", domain), name: null, ownerId: "mock-owner", lifecycle: "opportunity", deals: 1, openDeals: 1 };
      return null;
    },
    async upsertCompany(c) {
      const companyId = id("hs_co_", c.domain.toLowerCase());
      await record("hubspot.upsertCompany", { companyId, ...c });
      return { companyId, created: true, ownerId: c.ownerId ?? null };
    },
    async pushContact(c) {
      const contactId = c.hubspotContactId ?? id("hs_c_", (c.email ?? `${c.firstName} ${c.lastName} ${c.companyId}`).toLowerCase());
      await record("hubspot.pushContact", { contactId, ...c });
      return { contactId };
    },
    async upsertNote(n) {
      const noteId = n.noteId ?? id("hs_n_", n.companyId);
      await record("hubspot.upsertNote", { noteId, companyId: n.companyId, contactIds: n.contactIds, ownerId: n.ownerId, length: n.html.length });
      return { noteId, bodyHash: noteHash(n.html), kept: false };
    },
    async upsertTask(t) {
      const taskId = t.taskId ?? id("hs_t_", t.subject + (t.companyId ?? ""));
      await record("hubspot.createTask", { taskId, ...t });
      return { taskId };
    },
    async listOwners() {
      return [];
    },
    async followThrough(_companyId, taskIds) {
      return { tasks: taskIds.map((id) => ({ id, status: "NOT_STARTED", dueAt: null })), emails: 0, calls: 0, meetings: 0, deals: 0, openDeals: 0, stage: "lead", ownerId: null, lastActivityAt: null };
    },
    async listWonDeals() {
      // Sample wins for tests and demos only; the live adapter reads HubSpot.
      const d = (id: string, name: string, k: number, industry: string, employees: number, titles: string[], desc: string) => ({ id, name, amountCents: k * 100_000, closedAt: "2026-06-01", createdAt: "2026-04-15", description: desc, dealType: "newbusiness", source: null, company: { name: name.split(":")[0]!, domain: null, industry, employees, revenueCents: null, state: "Ohio", country: "United States" }, buyerTitles: titles });
      return [
        d("w1", "Northgate Freight: dispatch modernization", 85, "Logistics", 420, ["COO", "IT Director"], "Replace the Access-based dispatch system."),
        d("w2", "Keystone Health: AI readiness review", 18, "Hospital & Health Care", 900, ["CIO"], "AI governance and readiness assessment."),
        d("w3", "Harbor Property: workflow automation sprint", 40, "Real Estate", 260, ["VP Operations"], "Automate lease abstraction."),
      ];
    },
    async existingProperties() {
      return new Set<string>();
    },
    async createProperties() {
      return [];
    },
  };
}

export function hubspotAdapter(record: Recorder): HubSpotAdapter {
  return modeOf("hubspot") === "live" ? createLive() : createMock(record);
}
