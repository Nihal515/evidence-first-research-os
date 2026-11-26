// Reading a researcher's own paper in the browser: Word (.docx), OpenDocument (.odt),
// PDF, plain text and Markdown. The file is never uploaded. Plain code finds the
// reference list, splits it into references, finds the in-text citations and
// cross-checks the two. Nothing here uses AI.

export type PaperFormat = "docx" | "odt" | "pdf" | "txt" | "md";

export interface Citation {
  text: string;            // as written: "(Bloom et al., 2015)" or "[3]"
  kind: "author-year" | "numeric";
  surname: string;         // first author's family name, for author-year
  year: string;            // "2015" or "2015a"
  numbers: number[];       // for numeric citations
  sentence: string;        // the sentence it sits in
  para: number;
}

export interface ParsedPaper {
  fileName: string;
  format: PaperFormat;
  words: number;
  heading: string | null;  // the reference-list heading found, e.g. "References"
  references: string[];
  citations: Citation[];
  numbered: boolean;       // the reference list is numbered ([1], 1.)
}

export const ACCEPT = ".docx,.pdf,.odt,.txt,.md";
export const MAX_BYTES = 15_000_000;

// ---------------------------------------------------------------- text extraction
function xmlParagraphs(xml: string, pTag: string, textTags: string[], breakTags: string[]): string[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out: string[] = [];
  const paras = doc.getElementsByTagName(pTag);
  for (let i = 0; i < paras.length; i++) {
    let text = "";
    const walk = (node: Node) => {
      for (const child of Array.from(node.childNodes)) {
        const name = (child as Element).tagName;
        if (!name) continue;
        if (textTags.includes(name)) text += child.textContent ?? "";
        else if (breakTags.includes(name)) text += " ";
        else walk(child);
      }
    };
    walk(paras[i]!);
    out.push(text.replace(/\s+/g, " ").trim());
  }
  return out;
}

async function fromZip(file: File, kind: "docx" | "odt"): Promise<string[]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  if (kind === "docx") {
    const main = await zip.file("word/document.xml")?.async("string");
    if (!main) throw new Error("This .docx file has no document text.");
    const paras = xmlParagraphs(main, "w:p", ["w:t"], ["w:tab", "w:br"]);
    for (const extra of ["word/footnotes.xml", "word/endnotes.xml"]) {
      const xml = await zip.file(extra)?.async("string");
      if (xml) paras.push(...xmlParagraphs(xml, "w:p", ["w:t"], ["w:tab", "w:br"]));
    }
    return paras;
  }
  const content = await zip.file("content.xml")?.async("string");
  if (!content) throw new Error("This .odt file has no document text.");
  const doc = new DOMParser().parseFromString(content, "application/xml");
  return Array.from(doc.querySelectorAll("*"))
    .filter((e) => e.tagName === "text:p" || e.tagName === "text:h")
    .map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
}

async function fromPdf(file: File): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines: string[] = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 200); n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    let line = "";
    let lastY: number | null = null;
    for (const item of content.items as { str?: string; hasEOL?: boolean; transform?: number[] }[]) {
      if (typeof item.str !== "string") continue;
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && line.trim()) {
        lines.push(line.trim());
        line = "";
      }
      line += item.str;
      lastY = y;
      if (item.hasEOL) {
        lines.push(line.trim());
        line = "";
        lastY = null;
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.map((l) => l.replace(/\s+/g, " ")).filter(Boolean);
}

export function formatOf(name: string): PaperFormat | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (["docx", "odt", "pdf", "txt", "md"] as const).find((f) => f === ext) ?? null;
}

export async function readPaper(file: File): Promise<ParsedPaper> {
  const format = formatOf(file.name);
  if (!format) {
    const ext = file.name.toLowerCase().split(".").pop();
    throw new Error(ext === "doc" || ext === "rtf" || ext === "pages"
      ? `.${ext} files cannot be read here. Save it as a Word document (.docx) or PDF and upload that.`
      : "Upload a Word document (.docx), PDF, OpenDocument (.odt), or a .txt or .md file.");
  }
  if (file.size > MAX_BYTES) throw new Error("That file is larger than 15 MB.");
  const lines = format === "docx" || format === "odt" ? await fromZip(file, format)
    : format === "pdf" ? await fromPdf(file)
    : (await file.text()).split(/\r?\n/).map((l) => l.trim());
  return analyse(file.name, format, lines);
}

// ---------------------------------------------------------------- finding the reference list
const HEADING = /^\s*(?:\d+(?:\.\d+)*\.?\s*|[IVX]+\.\s*|#+\s*)?(references?|reference list|bibliography|works cited|literature cited|cited works|sources|list of references)\s*:?\s*$/i;
const AFTER = /^\s*(?:\d+\.?\s*|#+\s*)?(appendix|appendices|annex|supplementary|acknowledg(e)?ments?|author note|tables?|figures?)\b/i;
const STARTS_REF = /^(?:\[\d{1,3}\]|\d{1,3}[.)])\s+|^[A-Z][A-Za-zÀ-ɏ'’\-]+(?: [A-Z][A-Za-zÀ-ɏ'’\-]+)?,\s*(?:[A-Z]\.|[A-Z][a-z]+)|^[A-Z][A-Za-zÀ-ɏ'’\-]+ [A-Z]{1,3}[,.]/;
const YEARISH = /\((?:1[89]|20)\d\d[a-z]?\)|\b(?:1[89]|20)\d\d[a-z]?\.|10\.\d{4,9}\//;

export function findReferenceSection(lines: string[]): { start: number; end: number; heading: string } | null {
  let start = -1;
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.length <= 40 && HEADING.test(l)) {
      start = i + 1;
      heading = l.replace(/^[#\d.\s]+/, "").replace(/:$/, "").trim();
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.length <= 60 && AFTER.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { start, end, heading };
}

/** One entry per reference. Word paragraphs are already one per reference; PDF and text
 * lines are joined until the next line that starts a new reference. */
export function splitReferences(lines: string[], joinLines: boolean): string[] {
  const clean = lines.map((l) => l.trim()).filter((l) => l && !/^\d{1,4}$/.test(l)); // drop page numbers
  if (!joinLines) return clean.filter((l) => l.length >= 15);
  const out: string[] = [];
  for (const l of clean) {
    const prev = out[out.length - 1];
    const startsNew = STARTS_REF.test(l) && (!prev || /[.)\]]$|\d$|\/[^\s]*$/.test(prev) || YEARISH.test(prev));
    if (!prev || startsNew) out.push(l);
    else out[out.length - 1] = (prev.endsWith("-") && !/\d-$/.test(prev) ? prev.slice(0, -1) : prev + " ") + l;
  }
  return out.filter((l) => l.length >= 15);
}

// ---------------------------------------------------------------- in-text citations
const YEAR = "(?:1[89]|20)\\d\\d[a-z]?";
const NAME = "[A-Z][A-Za-z\\u00C0-\\u024F'’\\-]+";
const NARRATIVE = new RegExp(`\\b(${NAME})(?:\\s+(?:et al\\.|(?:and|&)\\s+${NAME}))?(?:’s|'s)?\\s+\\((${YEAR})(?:,\\s*p+\\.\\s*[\\d–-]+)?\\)`, "g");
const PAREN = new RegExp(`\\(([^()]{2,300}?${YEAR}[^()]{0,40}?)\\)`, "g");
const NUMERIC = /\[(\d{1,3}(?:\s*[-–,]\s*\d{1,3})*)\]/g;

export function sentenceAt(para: string, index: number): string {
  const parts = para.split(/(?<=[.!?])\s+(?=[A-Z“"(\[])/);
  let pos = 0;
  for (const p of parts) {
    const at = para.indexOf(p, pos);
    if (index >= at && index < at + p.length) return p.trim();
    pos = at + p.length;
  }
  return para.trim();
}

function firstSurname(authorPart: string): string {
  const s = authorPart.replace(/^(?:e\.g\.,?|see(?: also)?|cf\.|as cited in)\s+/i, "").replace(/\bet al\.?/i, "").trim();
  return (s.split(/\s*(?:,|&|\band\b)\s*/)[0] ?? "").trim().split(/\s+/).pop() ?? "";
}

function expand(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.split(/[-–]/).map((x) => parseInt(x.trim(), 10));
    if (a && b && b >= a && b - a < 50) for (let n = a; n <= b; n++) out.push(n);
    else if (a) out.push(a);
  }
  return out;
}

export function findCitations(paras: string[]): Citation[] {
  const out: Citation[] = [];
  paras.forEach((para, i) => {
    for (const m of para.matchAll(PAREN)) {
      for (const piece of m[1]!.split(";")) {
        const pm = piece.trim().match(new RegExp(`^(.*?),?\\s+(${YEAR})(?:[,:]\\s*(?:p+\\.\\s*)?[\\d–-]+)?$`));
        if (!pm) continue;
        const surname = firstSurname(pm[1]!);
        if (!/^[A-ZÀ-ɏ]/.test(surname)) continue;
        out.push({ text: m[0]!, kind: "author-year", surname, year: pm[2]!, numbers: [], sentence: sentenceAt(para, m.index!), para: i });
      }
    }
    for (const m of para.matchAll(NARRATIVE)) {
      out.push({ text: m[0]!, kind: "author-year", surname: m[1]!, year: m[2]!, numbers: [], sentence: sentenceAt(para, m.index!), para: i });
    }
    for (const m of para.matchAll(NUMERIC)) {
      out.push({ text: m[0]!, kind: "numeric", surname: "", year: "", numbers: expand(m[1]!), sentence: sentenceAt(para, m.index!), para: i });
    }
  });
  return out;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The reference a citation points to: first author's family name near the start of the
 * entry and the same year; or, for [n], the n-th entry of a numbered list. */
export function matchCitation(c: Citation, refs: string[], numbered: boolean): number[] {
  if (c.kind === "numeric") return numbered ? c.numbers.map((n) => n - 1).filter((i) => i >= 0 && i < refs.length) : [];
  const name = fold(c.surname);
  const hits: number[] = [];
  refs.forEach((r, i) => {
    const head = fold(r.replace(/^(?:\[\d+\]|\d+[.)])\s*/, "").slice(0, 80));
    if (new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(head) && r.includes(c.year.slice(0, 4))
      && (c.year.length === 4 || fold(r).includes(c.year))) hits.push(i);
  });
  return hits;
}

/** PDF and plain-text lines are wrapped: join them back into paragraphs, so a citation such
 * as "(Noy &\nZhang, 2023)" split over two lines is found. A blank line, a short heading or a
 * short line that ends a sentence closes a paragraph. */
export function joinWrapped(lines: string[]): string[] {
  const lens = lines.filter(Boolean).map((l) => l.length).sort((a, b) => a - b);
  const typical = lens[Math.floor(lens.length * 0.75)] ?? 80;
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const l of lines) {
    if (!l) { flush(); continue; }
    const heading = l.length < 50 && !/[.,;:)\]]$/.test(l) && /^[A-Z0-9#]/.test(l);
    if (heading) { flush(); out.push(l); continue; }
    cur = cur ? (cur.endsWith("-") && /[a-z]-$/.test(cur) ? cur.slice(0, -1) : cur + " ") + l : l;
    if (/[.!?”"]$/.test(l) && l.length < typical * 0.8) flush();
  }
  flush();
  return out;
}

export function analyse(fileName: string, format: PaperFormat, rawLines: string[]): ParsedPaper {
  const lines = rawLines.map((l) => l.replace(/\s+/g, " ").trim());
  const section = findReferenceSection(lines);
  let refLines: string[];
  let body: string[];
  // (body is re-joined below for wrapped formats)
  if (section) {
    refLines = lines.slice(section.start, section.end);
    body = lines.slice(0, section.start - 1);
  } else {
    // no heading: take the lines that look like references (a year in brackets or a DOI)
    refLines = lines.filter((l) => l.length > 30 && STARTS_REF.test(l) && YEARISH.test(l));
    body = lines.filter((l) => !refLines.includes(l));
  }
  const wrapped = format === "pdf" || format === "txt" || format === "md";
  if (wrapped) body = joinWrapped(body);
  const references = splitReferences(refLines, wrapped);
  const numbered = references.length > 0 && references.filter((r) => /^(?:\[\d+\]|\d+[.)])\s/.test(r)).length >= references.length * 0.6;
  const words = body.join(" ").split(/\s+/).filter(Boolean).length;
  return { fileName, format, words, heading: section?.heading ?? null, references, citations: findCitations(body), numbered };
}

/** Remove the list number so each reference is checked as written. */
export const refText = (r: string) => r.replace(/^(?:\[\d+\]|\d+[.)])\s*/, "").trim();
