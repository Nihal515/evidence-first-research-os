// One place for every export: APA 7 copy / Word / text, BibTeX and RIS.
// Only Verified references with registered metadata are exported; the rest are
// counted and reported, never silently dropped or guessed.
import { api } from "../api";
import type { Reference } from "../types";
import { formatBibliography } from "./apa";
import { exportable, toBibtex, toRis } from "./citations";
import { copyText, downloadBlob, referencesDocx } from "./exporters";

export type ExportFormat = "apa-copy" | "apa-docx" | "apa-txt" | "bibtex" | "ris";

export const EXPORT_LABELS: Record<ExportFormat, string> = {
  "apa-copy": "Copy APA 7 list",
  "apa-docx": "Download Word (.docx)",
  "apa-txt": "Download text (.txt)",
  bibtex: "Download BibTeX (.bib)",
  ris: "Download RIS (.ris)",
};

export interface ExportResult {
  ok: boolean;
  message: string;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export async function runExport(projectId: string, refs: Reference[], format: ExportFormat): Promise<ExportResult> {
  const { items, excluded } = exportable(refs);
  const note = excluded ? ` ${plural(excluded, "reference")} not verified ${excluded === 1 ? "was" : "were"} left out.` : "";
  if (!items.length) {
    return { ok: false, message: "Nothing to export: only Verified references can be exported. Use Check again first." };
  }
  const detail = { count: items.length, excluded };
  try {
    if (format === "bibtex") {
      downloadBlob(new Blob([toBibtex(items)], { type: "application/x-bibtex;charset=utf-8" }), "references.bib");
      api.event(projectId, "EXPORT_BIBTEX_DOWNLOADED", { ...detail, format: "bib" });
      return { ok: true, message: `Downloaded references.bib (${plural(items.length, "reference")}).${note}` };
    }
    if (format === "ris") {
      downloadBlob(new Blob([toRis(items)], { type: "application/x-research-info-systems;charset=utf-8" }), "references.ris");
      api.event(projectId, "EXPORT_RIS_DOWNLOADED", { ...detail, format: "ris" });
      return { ok: true, message: `Downloaded references.ris (${plural(items.length, "reference")}).${note}` };
    }
    const html = formatBibliography(items, "html");
    const text = formatBibliography(items, "text");
    if (format === "apa-copy") {
      const rich = `<p style="text-align:center"><b>References</b></p>` +
        html.map((h) => `<p style="padding-left:0.5in;text-indent:-0.5in">${h}</p>`).join("");
      const ok = await copyText(text.join("\n\n"), rich);
      if (!ok) return { ok: false, message: "Copy failed — use Download instead." };
      api.event(projectId, "EXPORT_APA_COPIED", detail);
      return { ok: true, message: `Copied ${plural(text.length, "APA 7 reference")}.${note}` };
    }
    if (format === "apa-docx") {
      downloadBlob(await referencesDocx(html), "references-apa7.docx");
      api.event(projectId, "EXPORT_APA_DOWNLOADED", { ...detail, format: "docx" });
      return { ok: true, message: `Downloaded references-apa7.docx.${note}` };
    }
    downloadBlob(new Blob(["References\n\n" + text.join("\n\n") + "\n"], { type: "text/plain;charset=utf-8" }),
      "references-apa7.txt");
    api.event(projectId, "EXPORT_APA_DOWNLOADED", { ...detail, format: "txt" });
    return { ok: true, message: `Downloaded references-apa7.txt.${note}` };
  } catch {
    return { ok: false, message: "The export failed. Please reload the page and try again." };
  }
}

/** One APA 7 entry, for the detail panel's "Cite" box. */
export function apaFor(ref: Reference): { html: string; text: string } | null {
  if (ref.label !== "verified" || !ref.csl) return null;
  try {
    return { html: formatBibliography([ref.csl], "html")[0] ?? "", text: formatBibliography([ref.csl], "text")[0] ?? "" };
  } catch {
    return null;
  }
}
