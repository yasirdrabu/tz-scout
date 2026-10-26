import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { domainOf, employeesOf, groupRows, parseCsv, parseMarkdown, readSheet, suggestMapping } from "@/lib/leadSheet";
import { handoffMessage, handoffMessages, replyBy } from "@/lib/handoff";

const enc = (s: string) => new TextEncoder().encode(s);

describe("reading lead sheets", () => {
  it("reads CSV with quotes, escaped quotes and line breaks inside a cell", () => {
    const rows = parseCsv('Company,Notes\r\n"Acme, Inc.","Said ""call me"" after\nthe demo"\r\nBeta,ok\r\n');
    expect(rows).toEqual([
      ["Company", "Notes"],
      ["Acme, Inc.", 'Said "call me" after\nthe demo'],
      ["Beta", "ok"],
    ]);
  });

  it("detects semicolon and tab delimiters and strips a byte order mark", () => {
    expect(parseCsv("﻿a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("reads a Markdown table and drops the separator row, bold and links", () => {
    const md = "Booth scans\n\n| Company | Website |\n|---|:---:|\n| **Acme** | [acme.com](https://acme.com) |\n";
    expect(parseMarkdown(md)).toEqual([["Company", "Website"], ["Acme", "acme.com"]]);
  });

  it("reads the first sheet of an .xlsx with shared and inline strings", async () => {
    const zip = new JSZip();
    zip.file("xl/workbook.xml", '<workbook><sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets></workbook>');
    zip.file("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file("xl/sharedStrings.xml", "<sst><si><t>Company</t></si><si><t>Email</t></si><si><t>Acme &amp; Sons</t></si></sst>");
    zip.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Employees</t></is></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>250</v></c></row></sheetData></worksheet>',
    );
    const sheet = await readSheet("leads.xlsx", await zip.generateAsync({ type: "uint8array" }));
    expect(sheet.headers).toEqual(["Company", "Email", "Employees"]);
    expect(sheet.rows).toEqual([["Acme & Sons", "", "250"]]);
  });

  it("refuses old .xls files and files without data rows", async () => {
    await expect(readSheet("old.xls", enc("x"))).rejects.toThrow(/\.xlsx or \.csv/);
    await expect(readSheet("empty.csv", enc("Company,Website\n"))).rejects.toThrow(/header row/);
  });
});

describe("columns and grouping", () => {
  it("suggests a mapping from common headers", () => {
    const m = suggestMapping(["Company Name", "Name", "Job Title", "Work Email", "Company Website", "Mobile", "# Employees", "Comments"]);
    expect(m).toMatchObject({ company: 0, fullName: 1, title: 2, email: 3, website: 4, phone: 5, employees: 6, notes: 7 });
  });

  it("finds the company domain from a website or a work email, never a personal one", () => {
    expect(domainOf("https://www.Acme.com/about")).toBe("acme.com");
    expect(domainOf("jane@acme-health.org")).toBe("acme-health.org");
    expect(domainOf("jane@gmail.com")).toBeNull();
    expect(domainOf("not a site")).toBeNull();
    expect(employeesOf("51-200 employees")).toBe(101);
    expect(employeesOf("1,200")).toBe(1200);
  });

  it("groups rows into companies with their people and lists skipped rows with the reason", () => {
    const rows = [
      ["Acme", "", "Jane Doe", "CIO", "jane@acme.com"],
      ["Acme", "acme.com", "Raj Patel", "COO", "raj@acme.com"],
      ["Acme", "", "Jane Doe", "CIO", "JANE@acme.com"],
      ["Solo", "", "Sam Lee", "CEO", "sam@gmail.com"],
      ["Nobody", "", "", "", ""],
    ];
    const { companies, skipped } = groupRows(rows, { company: 0, website: 1, fullName: 2, title: 3, email: 4 });
    expect(companies).toHaveLength(1);
    expect(companies[0]!.domain).toBe("acme.com");
    expect(companies[0]!.people.map((p) => p.firstName)).toEqual(["Jane", "Raj"]);
    expect(companies[0]!.rows).toEqual([2, 3, 4]);
    expect(skipped.map((s) => s.row)).toEqual([5, 6]);
    expect(skipped[0]!.reason).toMatch(/Personal email/);
  });
});

describe("handoff messages", () => {
  const acct = (name: string, sellerId: string | null, seller: string | null) => ({ name, domain: `${name.toLowerCase()}.com`, offer: "AI Opportunity Map", buyer: { name: "Jane Doe", title: "CIO", email: "jane@x.com" }, hubspotUrl: `https://app.hubspot.com/contacts/1/record/0-2/${name}`, sellerId, seller });

  it("asks for first touch two working days out", () => {
    expect(replyBy(new Date(2026, 9, 23)).getDate()).toBe(27); // Friday to Tuesday
    expect(replyBy(new Date(2026, 9, 20)).getDate()).toBe(22); // Tuesday to Thursday
  });

  it("writes one message per rep with each account, the offer, the buyer and the HubSpot link", () => {
    const msgs = handoffMessages({ from: "Zach Wiant", at: new Date(2026, 9, 23), accounts: [acct("Acme", "a", "Ashkan Eskandari"), acct("Beta", "m", "Mike Hammerslag"), acct("Gamma", "a", "Ashkan Eskandari")] });
    expect(msgs.map((m) => [m.seller, m.count])).toEqual([["Ashkan Eskandari", 2], ["Mike Hammerslag", 1]]);
    const ash = msgs[0]!.text;
    expect(ash).toMatch(/^Hi Ashkan, 2 new accounts are in HubSpot for you\./);
    expect(ash).toContain("1. Acme (acme.com): AI Opportunity Map. Start with Jane Doe, CIO (jane@x.com).");
    expect(ash).toContain("https://app.hubspot.com/contacts/1/record/0-2/Gamma");
    expect(ash).toContain("by Tuesday, Oct 27");
    expect(ash.trim().endsWith("Zach")).toBe(true);
    expect(msgs[1]!.text).toMatch(/1 new account is in HubSpot/);
    expect(ash).not.toContain("—");
  });

  it("says so when there's no buyer contact yet", () => {
    expect(handoffMessage({ seller: "Andy Hickey", from: null, accounts: [{ name: "Delta", domain: "delta.com", offer: null, buyer: null, hubspotUrl: null }] })).toContain("No buyer contact yet");
  });
});
