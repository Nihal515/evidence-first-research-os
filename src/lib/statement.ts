import type { Summary } from "../types";

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

/** Builds the AI-use statement only from recorded activity. Nothing is assumed. */
export function buildStatement(s: Summary, when: Date = new Date()): string {
  const date = when.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const sentences: string[] = [];
  const project = s.project.title ? ` for “${s.project.title}”` : "";

  sentences.push(`I used Paper Trail, a research-assistant website, while preparing this work${project}.`);

  if (s.searches > 0) {
    const where = s.search_providers.length ? list(s.search_providers) : "scholarly databases";
    sentences.push(`It searched ${where} ${times(s.searches)} to help me find sources.`);
  }

  if (s.checks.total > 0) {
    const where = s.sources_checked.length ? list(s.sources_checked) : "scholarly databases";
    const parts = [`${s.checks.verified} verified`, `${s.checks.not_found} not found`];
    if (s.checks.not_yet_verified) parts.push(`${s.checks.not_yet_verified} not yet verified`);
    sentences.push(`It checked ${plural(s.checks.total, "reference")} live against ${where}: ${list(parts)}.`);
  }

  if (s.references.total > 0) {
    let line = `I approved each of the ${plural(s.references.total, "source")} in my reference list myself with one click; nothing was added automatically.`;
    if (s.references.not_yet_verified > 0) {
      line += ` ${plural(s.references.not_yet_verified, "of them is", "of them are")} still not yet verified.`;
    }
    sentences.push(line);
  }

  if (s.references.verified > 0) {
    sentences.push(
      "The APA 7 reference list was formatted from each publisher’s registered metadata by a citation formatter (citeproc-js), not written by AI.",
    );
  }

  if (s.ai_runs === 0) {
    sentences.push("No generative AI was used through this tool to write, summarise or paraphrase any text.");
  } else {
    const f = s.ai_features ?? { search_terms: 0, readings: 0, claim_checks: 0 };
    const uses: string[] = [];
    if (f.search_terms) uses.push(`to suggest search terms ${times(f.search_terms)}`);
    if (f.readings) uses.push(`to point at the aim, method, findings and limits in ${plural(f.readings, "source abstract")}`);
    if (f.claim_checks) uses.push(`to test ${plural(f.claim_checks, "of my sentences", "of my sentences")} against source abstracts`);
    const model = s.ai_models?.length ? ` (${list(s.ai_models)})` : "";
    sentences.push(
      `I used the tool’s generative AI${model} ${uses.length ? list(uses) : `${times(s.ai_runs)}`}. ` +
        "Every AI output was labelled “AI suggestion”; quotes were kept only if they appeared word for word in the source, " +
        "and the AI did not decide which sources were real, add any source, or write the text of this work.",
    );
  }

  sentences.push("I remain responsible for the accuracy of the content and citations in this work.");

  return `AI-use statement\n\n${sentences.join(" ")}\n\nGenerated on ${date} from the tool’s activity log.`;
}
