// BibTeX and RIS export, and BibTeX / RIS import parsing. Deterministic code.
// Export uses the registered (CSL) metadata of Verified references only, the
// same rule as the APA 7 list: an unverified record is never exported as fact.
import type { CheckInput, CslItem, Reference } from "../types";

interface CslName { family?: string; given?: string; literal?: string }
type Csl = CslItem & {
  author?: CslName[];
  editor?: CslName[];
  issued?: { "date-parts"?: (number | string)[][] };
  "container-title"?: string | string[];
  volume?: string | number;
  issue?: string | number;
  page?: string;
  publisher?: string;
  DOI?: string;
  URL?: string;
  ISSN?: string | string[];
};

const BIBTEX_TYPE: Record<string, string> = {
  "article-journal": "article", "article-magazine": "article", "article-newspaper": "article", article: "article",
  book: "book", chapter: "incollection", "paper-conference": "inproceedings", thesis: "phdthesis",
  report: "techreport", dataset: "misc", webpage: "misc",
};
const RIS_TYPE: Record<string, string> = {
  "article-journal": "JOUR", "article-magazine": "MGZN", "article-newspaper": "NEWS", article: "JOUR",
  book: "BOOK", chapter: "CHAP", "paper-conference": "CPAPER", thesis: "THES", report: "RPRT",
  dataset: "DATA", webpage: "ELEC",
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const year = (c: Csl) => String(c.issued?.["date-parts"]?.[0]?.[0] ?? "");
const nameText = (n: CslName) => (n.literal ? n.literal : [n.family, n.given].filter(Boolean).join(", "));

function bibEscape(s: string): string {
  return s.replace(/\\/g, "\\textbackslash{}").replace(/([{}&%$#_])/g, "\\$1").replace(/~/g, "\\textasciitilde{}");
}

function citeKey(c: Csl, used: Set<string>): string {
  const fam = (c.author?.[0]?.family || c.author?.[0]?.literal || "anon").normalize("NFKD").replace(/[^A-Za-z]/g, "");
  const word = (c.title || "").normalize("NFKD").split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, ""))
    .find((w) => w.length > 3) || "ref";
  const base = `${fam.toLowerCase() || "anon"}${year(c) || "nd"}${word.toLowerCase()}`;
  let key = base;
  for (let i = 0; used.has(key); i++) key = base + String.fromCharCode(97 + (i % 26)) + (i >= 26 ? i : "");
  used.add(key);
  return key;
}

export function exportable(refs: Reference[]): { items: Csl[]; excluded: number } {
  const items = refs.filter((r) => r.label === "verified" && r.csl).map((r) => r.csl as Csl);
  return { items, excluded: refs.length - items.length };
}

export function toBibtex(items: Csl[]): string {
  const used = new Set<string>();
  return items.map((c) => {
    const type = BIBTEX_TYPE[c.type] ?? "misc";
    const container = first(c["container-title"]);
    const fields: [string, string][] = [
      ["title", c.title],
      ["author", (c.author ?? []).map(nameText).join(" and ")],
      ["editor", (c.editor ?? []).map(nameText).join(" and ")],
      [type === "article" ? "journal" : type === "incollection" || type === "inproceedings" ? "booktitle" : "howpublished", container],
      ["year", year(c)],
      ["volume", String(c.volume ?? "")],
      ["number", String(c.issue ?? "")],
      ["pages", (c.page ?? "").replace(/[–—-]+/, "--")],
      ["publisher", c.publisher ?? ""],
      ["doi", c.DOI ?? ""],
      ["url", c.URL ?? ""],
    ];
    const body = fields.filter(([, v]) => v).map(([k, v]) => `  ${k} = {${bibEscape(String(v))}}`).join(",\n");
    return `@${type}{${citeKey(c, used)},\n${body}\n}`;
  }).join("\n\n") + (items.length ? "\n" : "");
}

export function toRis(items: Csl[]): string {
  return items.map((c) => {
    const lines: string[] = [`TY  - ${RIS_TYPE[c.type] ?? "GEN"}`, `TI  - ${c.title}`];
    for (const a of c.author ?? []) lines.push(`AU  - ${nameText(a)}`);
    for (const e of c.editor ?? []) lines.push(`ED  - ${nameText(e)}`);
    if (year(c)) lines.push(`PY  - ${year(c)}`);
    const container = first(c["container-title"]);
    if (container) lines.push(`${c.type === "chapter" ? "BT" : "T2"}  - ${container}`);
    if (c.volume) lines.push(`VL  - ${c.volume}`);
    if (c.issue) lines.push(`IS  - ${c.issue}`);
    const [sp, ep] = (c.page ?? "").split(/[–—-]+/);
    if (sp) lines.push(`SP  - ${sp}`);
    if (ep) lines.push(`EP  - ${ep}`);
    if (c.publisher) lines.push(`PB  - ${c.publisher}`);
    if (c.DOI) lines.push(`DO  - ${c.DOI}`);
    if (c.URL) lines.push(`UR  - ${c.URL}`);
    lines.push("ER  - ");
    return lines.join("\r\n");
  }).join("\r\n\r\n") + (items.length ? "\r\n" : "");
}

// ------------------------------------------------------------------ import
export interface ImportedItem {
  title: string;
  authors: string;   // "Family, G.; Family, G."
  year: number | null;
  doi: string;
}

export function importInput(item: ImportedItem): CheckInput {
  return { mode: "fields", title: item.title, authors: item.authors, year: item.year, doi: item.doi };
}

const cleanDoi = (s: string) => s.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
const yearOf = (s: string) => {
  const m = s.match(/\b(1[5-9]\d\d|20\d\d|2100)\b/);
  return m ? Number(m[1]) : null;
};

function unbrace(s: string): string {
  return s.replace(/\\[`'^"~=.uvHcdbtk]\{?([A-Za-z])\}?/g, "$1").replace(/\\&/g, "&").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/** Parse BibTeX entries: fields in {…} (nested braces allowed), "…" or bare numbers. */
export function parseBibtex(src: string): ImportedItem[] {
  const out: ImportedItem[] = [];
  const entryRe = /@(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(src))) {
    const type = m[1].toLowerCase();
    let i = entryRe.lastIndex, depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    entryRe.lastIndex = i;
    if (["comment", "preamble", "string"].includes(type)) continue;
    const body = src.slice(start, i - 1);
    const fields: Record<string, string> = {};
    const comma = body.indexOf(",");
    let j = comma < 0 ? body.length : comma + 1;
    while (j < body.length) {
      const fm = /\s*([A-Za-z][\w-]*)\s*=\s*/y;
      fm.lastIndex = j;
      const f = fm.exec(body);
      if (!f) break;
      j = fm.lastIndex;
      let value = "";
      if (body[j] === "{") {
        let d = 0, k = j;
        for (; k < body.length; k++) {
          if (body[k] === "{") d++;
          else if (body[k] === "}") { d--; if (d === 0) break; }
        }
        value = body.slice(j + 1, k);
        j = k + 1;
      } else if (body[j] === '"') {
        const k = body.indexOf('"', j + 1);
        value = body.slice(j + 1, k < 0 ? body.length : k);
        j = k < 0 ? body.length : k + 1;
      } else {
        const vm = /[^,]*/y;
        vm.lastIndex = j;
        value = vm.exec(body)?.[0] ?? "";
        j = vm.lastIndex;
      }
      fields[f[1].toLowerCase()] = unbrace(value);
      const next = body.indexOf(",", j);
      j = next < 0 ? body.length : next + 1;
    }
    const title = fields.title ?? "";
    if (!title && !fields.doi) continue;
    const authors = (fields.author ?? "").split(/\s+and\s+/i).map((a) => a.trim()).filter(Boolean).join("; ");
    out.push({ title, authors, year: yearOf(fields.year ?? fields.date ?? ""), doi: cleanDoi(fields.doi ?? "") });
  }
  return out;
}

/** Parse RIS records (TY … ER). */
export function parseRis(src: string): ImportedItem[] {
  const out: ImportedItem[] = [];
  let cur: Record<string, string[]> | null = null;
  for (const raw of src.split(/\r?\n/)) {
    const m = raw.match(/^([A-Z][A-Z0-9])  -\s?(.*)$/);
    if (!m) continue;
    const [, tag, value] = m;
    if (tag === "TY") cur = {};
    else if (tag === "ER") {
      if (cur) {
        const title = (cur.TI ?? cur.T1 ?? cur.CT ?? [""])[0].trim();
        const doi = cleanDoi((cur.DO ?? [""])[0]);
        if (title || doi) {
          out.push({
            title,
            authors: [...(cur.AU ?? []), ...(cur.A1 ?? [])].map((a) => a.trim()).filter(Boolean).join("; "),
            year: yearOf((cur.PY ?? cur.Y1 ?? cur.DA ?? [""])[0]),
            doi,
          });
        }
      }
      cur = null;
    } else if (cur) (cur[tag] ??= []).push(value);
  }
  return out;
}

export function parseImport(filename: string, text: string): ImportedItem[] {
  const name = filename.toLowerCase();
  if (name.endsWith(".ris") || /^TY  - /m.test(text)) return parseRis(text);
  return parseBibtex(text);
}
