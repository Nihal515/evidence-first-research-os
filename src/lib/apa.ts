// APA 7th edition formatting with citeproc-js and the official CSL "apa.csl" style
// (Citation Style Language project, CC BY-SA 3.0). Formatting is deterministic:
// it uses only the registered metadata, never AI-written text.
// @ts-ignore - citeproc ships without type definitions
import CSL from "citeproc";
import style from "../csl/apa.csl?raw";
import locale from "../csl/locales-en-US.xml?raw";
import type { CslItem } from "../types";

export type OutputFormat = "html" | "text";

export function formatBibliography(items: CslItem[], format: OutputFormat = "html"): string[] {
  if (!items.length) return [];
  const byId: Record<string, CslItem> = {};
  for (const item of items) byId[item.id] = item;
  const engine = new CSL.Engine(
    { retrieveLocale: () => locale, retrieveItem: (id: string) => byId[id] },
    style,
    "en-US",
  );
  engine.setOutputFormat(format);
  engine.updateItems(items.map((i) => i.id));
  const result = engine.makeBibliography();
  if (!result) return [];
  return (result[1] as string[]).map((entry) =>
    format === "html"
      ? entry.replace(/^\s*<div class="csl-entry">/, "").replace(/<\/div>\s*$/, "").trim()
      : entry.trim(),
  );
}
