// Turn a URL or an uploaded file into plain text for the AI draft. Supports web pages, PDF, Word,
// PowerPoint, and plain text formats.

const stripHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|h\d|li|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

export async function textFromUrl(url: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("That doesn't look like a web address.");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Use an http or https address.");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) throw new Error("Internal addresses can't be read.");
  let res: Response;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(12000), headers: { "user-agent": "Mozilla/5.0 (offer intake)" }, redirect: "follow" });
  } catch {
    throw new Error("Couldn't reach that page. Check the address, or upload the file instead.");
  }
  if (!res.ok) throw new Error(`That page returned ${res.status}.`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("pdf")) return textFromPdf(new Uint8Array(await res.arrayBuffer()));
  return stripHtml(await res.text()).slice(0, 60000);
}

async function textFromPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).slice(0, 60000);
}

async function textFromOfficeZip(bytes: Uint8Array, kind: "docx" | "pptx"): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.keys(zip.files)
    .filter((n) => (kind === "docx" ? n === "word/document.xml" : /^ppt\/slides\/slide\d+\.xml$/.test(n)))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
  const parts: string[] = [];
  for (const f of files) {
    const xml = await zip.file(f)!.async("string");
    const text = xml.replace(/<\/(w:p|a:p)>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    parts.push(text.trim());
  }
  return parts.join("\n\n").slice(0, 60000);
}

export async function textFromFile(file: File): Promise<string> {
  if (file.size > 8 * 1024 * 1024) throw new Error("Files up to 8 MB.");
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith(".pdf")) return textFromPdf(bytes);
  if (name.endsWith(".docx")) return textFromOfficeZip(bytes, "docx");
  if (name.endsWith(".pptx")) return textFromOfficeZip(bytes, "pptx");
  if (/\.(html?|htm)$/.test(name)) return stripHtml(new TextDecoder().decode(bytes));
  if (/\.(txt|md|csv|json)$/.test(name)) return new TextDecoder().decode(bytes).slice(0, 60000);
  throw new Error("Upload a PDF, Word, PowerPoint, HTML or text file.");
}
