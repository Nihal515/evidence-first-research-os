const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#38;": "&", "&#39;": "'", "&nbsp;": " " };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&(amp|lt|gt|quot|nbsp);|&#38;|&#39;/g, (m) => ENTITIES[m] ?? m);
}

/** Split citeproc HTML into runs, keeping italics (APA italicises journal names, volumes and book titles). */
export function htmlToRuns(html: string): { text: string; italic: boolean }[] {
  const runs: { text: string; italic: boolean }[] = [];
  let italic = false;
  for (const part of html.split(/(<\/?i>)/)) {
    if (part === "<i>") italic = true;
    else if (part === "</i>") italic = false;
    else {
      const text = decodeEntities(part.replace(/<[^>]+>/g, ""));
      if (text) runs.push({ text, italic });
    }
  }
  return runs;
}

/** A Word document laid out as an APA 7 reference page: centred bold heading,
 * double spacing and a 0.5-inch hanging indent. */
export async function referencesDocx(entriesHtml: string[]): Promise<Blob> {
  const { AlignmentType, Document, Packer, Paragraph, TextRun } = await import("docx"); // loaded only when needed
  const font = "Times New Roman";
  const doc = new Document({
    styles: { default: { document: { run: { font, size: 24 } } } },
    sections: [
      {
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { line: 480 },
            children: [new TextRun({ text: "References", bold: true, font, size: 24 })],
          }),
          ...entriesHtml.map(
            (html) =>
              new Paragraph({
                spacing: { line: 480 },
                indent: { left: 720, hanging: 720 },
                children: htmlToRuns(html).map((r) => new TextRun({ text: r.text, italics: r.italic, font, size: 24 })),
              }),
          ),
        ],
      },
    ],
  });
  return Packer.toBlob(doc);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy rich text (keeps italics when pasted into Word or Google Docs) with a plain-text fallback. */
export async function copyText(plain: string, html?: string): Promise<boolean> {
  try {
    if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(plain);
      return true;
    }
  } catch {
    /* fall through to the legacy method */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = plain;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
