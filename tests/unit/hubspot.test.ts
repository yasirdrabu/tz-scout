import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHubSpotContext, type ContextSignal } from "@/lib/hubspotContext";
import { createLive, noteHash } from "@/integrations/hubspot/live";

const NOW = new Date("2026-10-15T12:00:00Z");

describe("the context a rep gets in HubSpot", () => {
  const signals: ContextSignal[] = [
    { id: "s1", type: "intent", title: "Researching: Legacy system modernization", detail: "Research score 79", url: null, value: 0.79, occurredAt: NOW },
    { id: "s2", type: "risk", title: "Lawsuit: Website tracking settlement", detail: "Privacy violation", url: "https://example.com/case", value: null, occurredAt: new Date("2026-05-19") },
    { id: "s3", type: "hiring", title: "Hiring in operations: inventory specialist", detail: null, url: null, value: null, occurredAt: new Date("2026-01-28") },
  ];
  const ctx = buildHubSpotContext({
    account: { name: "Riverbend Health", domain: "riverbend-health.example", industry: "Healthcare services", employeesRange: "1001-5000", revenueRange: "200M-500M", location: "Carbondale, Illinois", description: null, technologies: ["Microsoft Access", "Epic"], source: "vibe" },
    best: {
      offering: "Modernization Blueprint", tier: "act_now", fit: 85, signal: 71, total: 79,
      fitParts: [{ label: "Industry", points: 30, max: 30, note: "Healthcare services is a target industry." }, { label: "Buyer on file", points: 15, max: 15, note: "Pat Doe, COO." }],
      hits: [
        { ruleId: "mb-intent", label: "Researching legacy modernization", type: "intent", kind: "research", points: 39, max: 40, signalIds: ["s1"], matched: ["Researching: Legacy system modernization"], why: "They're researching how to replace an old system." },
        { ruleId: "mb-risk", label: "Outage or breach", type: "risk", kind: "trigger", points: 2, max: 15, signalIds: ["s2"], matched: [], why: "An incident turns someday into a budget line." },
        { ruleId: "mb-legacy-tech", label: "Running legacy software", type: "tech", kind: "pain", points: 30, max: 30, signalIds: [], matched: ["Microsoft Access"], why: "Old platforms are a ticking clock." },
      ],
      whyNow: "They're researching legacy modernization this week.", angle: "Lead with the cost of the old system.", opener: "Hi Pat, I noticed you're hiring.", contactTitle: "COO",
    },
    others: [{ offering: "AgentReady Diagnostic", tier: "good_fit", fit: 85, signal: 3, total: 48, hits: [], whyNow: null, angle: null, opener: null, contactTitle: null }],
    signals,
    contacts: [{ name: "Pat Doe", title: "COO", email: "pat@riverbend-health.example", emailStatus: "valid", phone: "+1 618 555 0100", linkedinUrl: null, primary: true }],
    offer: { name: "Modernization Blueprint", promise: "A fixed price for Release 1 in two weeks, or it's free.", priceMinCents: 1000000, priceMaxCents: 1000000, salesCycleDays: 30, targetTitles: ["COO", "CIO"], proofPoints: ["Guarantee: free if Release 1 can't be fixed-priced"], caseStudies: [{ title: "Claims platform rebuild", client: "A regional carrier", result: "Release 1 live in 14 weeks", link: null }] },
    missing: [{ label: "Acquisition to integrate", weight: 15, why: "Every acquisition has to learn how the company works." }],
    briefBy: "Brief assembled from the signals by rules (Claude not connected yet).",
    owner: "Ashkan Eskandari",
    now: NOW,
  });

  it("the note explains why, with every signal, its date and source, and why it matters", () => {
    expect(ctx.html).toContain("Why Riverbend Health is a lead");
    expect(ctx.html).toContain("Best offer: <strong>Modernization Blueprint</strong> · <strong>Act now</strong> · overall 79 of 100 (fit 85, buying signals 71) · Owner: Ashkan Eskandari");
    expect(ctx.html).toContain("Strong fit and a reason to buy now");
    expect(ctx.html).toMatch(/Active research.*Trigger event.*Visible pain/s);
    expect(ctx.html).toContain("Researching: Legacy system modernization (79)");
    expect(ctx.html).toContain('<a href="https://example.com/case">Lawsuit: Website tracking settlement, 2026-05-19</a>');
    expect(ctx.html).toContain("Why it matters: They&#39;re researching".replace("&#39;", "'"));
    expect(ctx.html).toContain("Hiring in operations: inventory specialist"); // not counted, still listed
    expect(ctx.html).toContain("AgentReady Diagnostic: 48 overall (fit 85, signals 3), Good fit");
  });
  it("carries the offer, why it fits, what would make it stronger, and every research topic", () => {
    expect(ctx.html).toContain("The offer: Modernization Blueprint");
    expect(ctx.html).toContain("What it is: A fixed price for Release 1 in two weeks, or it&#39;s free.".replace("&#39;", "'"));
    expect(ctx.html).toContain("Price: $10,000");
    expect(ctx.html).toContain("Case study: Claims platform rebuild (A regional carrier): Release 1 live in 14 weeks");
    expect(ctx.html).toContain("Why it fits (85 of 100)");
    expect(ctx.html).toContain("Industry: 30 of 30. Healthcare services is a target industry.");
    expect(ctx.html).toContain("Acquisition to integrate (up to 15 points)");
    expect(ctx.html).toContain("Legacy system modernization: 79 of 100 (active)");
    expect(ctx.html).toContain("How to read it:");
    expect(ctx.html).toContain("Brief assembled from the signals by rules");
  });
  it("lists the buyers with email quality and phone, and the brief", () => {
    expect(ctx.html).toContain("★ Pat Doe, COO · pat@riverbend-health.example (verified) · +1 618 555 0100");
    expect(ctx.html).toContain('Opener: "Hi Pat, I noticed you&#39;re hiring."'.replace("&#39;", "'"));
  });
  it("escapes what came from outside", () => {
    const x = buildHubSpotContext({ account: { name: "A<b>", domain: "a.com", industry: null, employeesRange: null, revenueRange: null, location: null, description: null, technologies: [], source: "vibe" }, best: null, others: [], signals: [], contacts: [], owner: null, now: NOW });
    expect(x.html).toContain("A&lt;b&gt;");
    expect(x.html).not.toContain("<b>");
  });
  it("fills the company fields reps filter on", () => {
    expect(ctx.props).toMatchObject({ taazaa_best_offer: "Modernization Blueprint", taazaa_tier: "Act now", taazaa_fit_score: 85, taazaa_signal_score: 71, taazaa_total_score: 79, taazaa_research_topics: "Legacy system modernization (79)", taazaa_signal_source: "Vibe Prospecting" });
    expect(String(ctx.props.taazaa_top_signals).split("\n")[0]).toBe("Active research: Researching legacy modernization (Researching: Legacy system modernization (79))");
  });
  it("the task tells the owner what to do", () => {
    expect(ctx.taskSubject).toBe("Reach out to Riverbend Health: Modernization Blueprint");
    expect(ctx.taskBody).toContain("Start with: Pat Doe, COO (pat@riverbend-health.example)");
    expect(ctx.taskBody).toContain("Opener: Hi Pat");
  });
});

describe("live HubSpot adapter (stubbed API)", () => {
  type Call = { method: string; url: string; body: Record<string, unknown> | null };
  let calls: Call[];
  let existing: Record<string, unknown> | null;
  let noteBody = "<p>x</p>";
  const stub = (async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method: init.method ?? "GET", url, body });
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (url.endsWith("/companies/search")) return ok({ results: existing ? [existing] : [] });
    if (url.endsWith("/contacts/search")) return ok({ results: [] });
    if (url.includes("/owners")) return new Response(JSON.stringify({ message: "This app hasn't been granted all required scopes" }), { status: 403 });
    if (url.includes("/objects/notes/") && (init.method ?? "GET") === "GET") return ok({ id: "n1", properties: { hs_note_body: noteBody } });
    if (init.method === "POST") return ok({ id: "new1", properties: {} });
    return ok({ id: "x", properties: {} });
  }) as unknown as typeof fetch;

  beforeEach(() => {
    calls = [];
    existing = null;
    process.env.HUBSPOT_PRIVATE_APP_TOKEN = "test-token";
  });
  afterEach(() => {
    delete process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  });

  it("creates a new company with the owner and our fields", async () => {
    const hs = createLive(stub, async () => {});
    const r = await hs.upsertCompany({ domain: "acme.com", name: "Acme", ownerId: "111", props: { taazaa_tier: "Act now" } });
    expect(r).toEqual({ companyId: "new1", created: true, ownerId: "111" });
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/objects/companies"))!;
    expect(post.body!.properties).toMatchObject({ name: "Acme", domain: "acme.com", hubspot_owner_id: "111", taazaa_tier: "Act now" });
  });

  it("never takes a company from an owner someone else set", async () => {
    existing = { id: "c9", properties: { hubspot_owner_id: "999", lifecyclestage: "lead" } };
    const hs = createLive(stub, async () => {});
    const r = await hs.upsertCompany({ domain: "acme.com", name: "Acme", ownerId: "111", props: { taazaa_tier: "Act now" } });
    expect(r.ownerId).toBe("999");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body!.properties).toEqual({ taazaa_tier: "Act now" });
  });

  it("moves the owner when it's the one we set on an earlier push", async () => {
    existing = { id: "c9", properties: { hubspot_owner_id: "111" } };
    const hs = createLive(stub, async () => {});
    const r = await hs.upsertCompany({ domain: "acme.com", name: "Acme", ownerId: "222", ourOwnerId: "111" });
    expect(r.ownerId).toBe("222");
    expect(calls.find((c) => c.method === "PATCH")!.body!.properties).toEqual({ hubspot_owner_id: "222" });
  });

  it("reads customers and open deals for the check", async () => {
    existing = { id: "c9", properties: { name: "Acme", hubspot_owner_id: "999", lifecyclestage: "customer", num_associated_deals: "3", hs_num_open_deals: "1" } };
    const hs = createLive(stub, async () => {});
    expect(await hs.findCompany("acme.com")).toEqual({ id: "c9", name: "Acme", ownerId: "999", lifecycle: "customer", deals: 3, openDeals: 1 });
  });

  it("creates the note on the company and its contacts, then updates it in place", async () => {
    const hs = createLive(stub, async () => {});
    await hs.upsertNote({ companyId: "c1", contactIds: ["p1"], html: "<p>x</p>", ownerId: "111" });
    const post = calls.find((c) => c.url.endsWith("/objects/notes"))!;
    expect((post.body!.associations as unknown[]).length).toBe(2);
    calls = [];
    const r = await hs.upsertNote({ noteId: "n1", expectedHash: noteHash("<p>x</p>"), companyId: "c1", contactIds: [], html: "<p>y</p>" });
    expect(r).toMatchObject({ noteId: "n1", kept: false });
    expect(calls.find((c) => c.method === "PATCH")!.url).toMatch(/\/objects\/notes\/n1$/);
  });

  it("never overwrites a note someone edited in HubSpot: adds a new one instead", async () => {
    const hs = createLive(stub, async () => {});
    noteBody = "<p>x</p><p>Rep: spoke to Pat, call back in March.</p>";
    const r = await hs.upsertNote({ noteId: "n1", expectedHash: noteHash("<p>x</p>"), companyId: "c1", contactIds: [], html: "<p>y</p>" });
    expect(r).toMatchObject({ noteId: "new1", kept: true });
    expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/notes/"))).toBe(false);
  });

  it("sends phones and associates the contact to the company", async () => {
    const hs = createLive(stub, async () => {});
    await hs.pushContact({ email: "pat@acme.com", firstName: "Pat", lastName: "Doe", phone: "+1 555 0100", mobilePhone: "+1 555 0101", ownerId: "111", companyId: "c1" });
    expect(calls.find((c) => c.url.endsWith("/objects/contacts"))!.body!.properties).toMatchObject({ email: "pat@acme.com", phone: "+1 555 0100", mobilephone: "+1 555 0101", hubspot_owner_id: "111" });
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contacts/new1/associations/default/companies/c1"))).toBe(true);
  });

  it("a missing permission says so in plain words", async () => {
    const hs = createLive(stub, async () => {});
    await expect(hs.listOwners()).rejects.toThrow(/needs another permission/);
  });
});
