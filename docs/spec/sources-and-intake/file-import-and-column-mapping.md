# SRC-E4 File import and column mapping

Status: Draft · Release: R1

## Why

Research sheets, vendor exports and lead lists arrive as files with every possible column layout.
Today Scout recognises four ABM research layouts and guesses lead-list columns. The new version keeps
that, learns each source's layout once, and asks Claude only when it hasn't seen a layout before.

## Rules

- **Files:** CSV (comma, semicolon or tab, detected), Excel `.xlsx` (first sheet, or each sheet as its
  own import if the person chooses), Markdown pipe tables. Up to 20 MB and 10,000 rows per file.
  Parsing carries today's `leadSheet.ts` behaviour (quotes, line breaks in cells, BOM).
- Every import is a **batch** (source = the person importing, plus an optional "this list came from"
  vendor) with the original file attached.
- **Mapping targets** are `arrival.v1` fields: account fields, custom fields, person fields (one or
  many person column groups, e.g. "Contact 1 name, Contact 1 title"), signal fields (date, title, URL,
  type), research fields, `practice_hint`, `external_ref`, `notes`.
- **How a mapping is chosen**, first match wins:
  1. **Built-in layouts**: the ABM research layouts (`RESEARCH_FIELDS` in today's `research.ts`,
     including stacked "master" files) and the Vibe export layout (today's `vibeExport.ts` rules: 12
     months of events, M&A only when the company is a party, crime stories are not lawsuits, three
     most recent news items per type, industry from NAICS).
  2. **Saved mapping** for this source with the same header signature (normalised headers, sorted,
     hashed).
  3. **Header synonyms** (today's lead-sheet guesses: website, domain, company, first name, email, ...).
  4. **Claude suggestion** (AI task `csv_column_mapping`): headers plus 5 sample rows in, a
     mapping with a confidence per column out (Zod-checked). Columns under 0.6 confidence are left
     unmapped for the person.
- **Confirm step**: shown unless the mapping came from a built-in layout or a saved mapping and every
  required field is mapped. The page shows each target field, the chosen column, three sample values
  and the confidence; the person can change any of it. Confirming saves the mapping for the source.
- **Rows to arrivals**: rows are grouped into companies by domain (website column, else work-email
  domain), one arrival per company with all its people (today's grouping). Personal-email rows with no
  company are skipped with row number and reason. Rows with a company but no website wait with
  `needs_website` (today's held rows).
- **Practice filing**: a research sheet's agent column or file name is matched against practice
  keywords (today's buckets) and set as `practice_hint`.
- Each arrival's `payload.raw` is the original row or rows, with the header row.

## Stories

### SRC-E4-S1 Drop a file
As an operator, I want to drag one or many files onto the Import page, so that lists go in without
setup.
- SRC-E4-S1-AC1 Dropping 3 files creates 3 imports, each a batch with its file attached.
- SRC-E4-S1-AC2 A file over 20 MB or 10,000 rows is refused with the limit stated.
- SRC-E4-S1-AC3 An `.xlsx` with several sheets asks "Import which sheets?" before mapping.

### SRC-E4-S2 Recognise known layouts
As an operator, I want research sheets and Vibe exports to import straight away, so that I don't map
columns I've mapped before.
- SRC-E4-S2-AC1 Each of the four research layouts and a stacked master file import with no confirm
  step; the test fixtures from today's `research.test.ts` pass against the new mapper.
- SRC-E4-S2-AC2 A Vibe export imports with today's converter rules (fixtures from
  `vibeExport.test.ts`).
- SRC-E4-S2-AC3 A second file from the same source with the same headers in a different order uses the
  saved mapping with no confirm step.

### SRC-E4-S3 Map a new layout with Claude's help
As an operator, I want Scout to suggest the mapping for a file it hasn't seen, so that I only check it.
- SRC-E4-S3-AC1 For unknown headers Scout calls `csv_column_mapping` once per file and shows the
  suggestion with confidence; with the Claude connection mode = mock the header synonyms are used and the
  page says "Suggested from column names".
- SRC-E4-S3-AC2 The confirm page lets the person map, unmap or split columns into person groups, and
  shows a preview of the first 5 arrivals it would create.
- SRC-E4-S3-AC3 Confirming saves the mapping for the source and header signature; it is listed and
  deletable in Settings, Sources.

### SRC-E4-S4 Import results
As an operator, I want a clear result for every row, so that I know what came in and what didn't.
- SRC-E4-S4-AC1 The import page shows: companies created, attached to existing, people added, waiting
  for a website (with a box per company to type it), skipped rows with row number and reason.
- SRC-E4-S4-AC2 The same counts are on the batch; `intake.batch.completed` fires when the waiting
  companies are resolved, or when the person chooses "Skip the rest", which rejects them `invalid`.
- SRC-E4-S4-AC3 `POST /api/v1/imports` and `:confirm` give agents the same flow over the API.
