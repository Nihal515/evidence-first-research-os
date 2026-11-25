import { describe, expect, it } from "vitest";
import { formatBibliography } from "./apa";
import { htmlToRuns } from "./exporters";
import { buildStatement } from "./statement";
import type { Summary } from "../types";

// CSL item exactly as the backend builds it from the Crossref record of 10.1038/nature14539.
const LECUN = {
  id: "10.1038/nature14539",
  type: "article-journal",
  title: "Deep learning",
  author: [
    { family: "LeCun", given: "Yann" },
    { family: "Bengio", given: "Yoshua" },
    { family: "Hinton", given: "Geoffrey" },
  ],
  issued: { "date-parts": [[2015, 5, 27]] },
  "container-title": "Nature",
  volume: "521",
  issue: "7553",
  page: "436-444",
  DOI: "10.1038/nature14539",
};

const BOOK = {
  id: "10.7551/mitpress/1234",
  type: "book",
  title: "Deep learning",
  author: [
    { family: "Goodfellow", given: "Ian" },
    { family: "Bengio", given: "Yoshua" },
    { family: "Courville", given: "Aaron" },
  ],
  issued: { "date-parts": [[2016]] },
  publisher: "MIT Press",
};

describe("APA 7 formatting", () => {
  it("formats a journal article exactly", () => {
    const [text] = formatBibliography([LECUN], "text");
    expect(text).toBe(
      "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539",
    );
  });

  it("italicises the journal name and volume only", () => {
    const [html] = formatBibliography([LECUN], "html");
    expect(html).toContain("<i>Nature</i>");
    expect(html).toContain("<i>521</i>(7553)");
    expect(html).not.toContain("<i>Deep learning</i>");
  });

  it("italicises a book title and lists the publisher", () => {
    const [text] = formatBibliography([BOOK], "text");
    expect(text).toBe("Goodfellow, I., Bengio, Y., & Courville, A. (2016). Deep learning. MIT Press.");
    const [html] = formatBibliography([BOOK], "html");
    expect(html).toContain("<i>Deep learning</i>");
  });

  it("sorts entries alphabetically by first author", () => {
    const entries = formatBibliography([LECUN, BOOK], "text");
    expect(entries[0].startsWith("Goodfellow")).toBe(true);
    expect(entries[1].startsWith("LeCun")).toBe(true);
  });

  it("keeps italics as runs for the Word export", () => {
    const [html] = formatBibliography([LECUN], "html");
    const runs = htmlToRuns(html);
    expect(runs.filter((r) => r.italic).map((r) => r.text)).toEqual(["Nature", "521"]);
    expect(runs.map((r) => r.text).join("")).toBe(formatBibliography([LECUN], "text")[0]);
  });
});

const BASE: Summary = {
  project: { title: "AI tutoring", question: "" },
  searches: 0,
  search_providers: [],
  checks: { total: 0, verified: 0, not_found: 0, not_yet_verified: 0 },
  sources_checked: [],
  references: { total: 0, verified: 0, not_yet_verified: 0, not_found: 0 },
  approvals: 0,
  exports: 0,
  ai_runs: 0,
  first_activity: null,
  last_activity: null,
  generated_at: "2026-11-25T18:00:00Z",
};

describe("AI-use statement", () => {
  it("states only what was recorded", () => {
    const text = buildStatement(
      {
        ...BASE,
        searches: 2,
        search_providers: ["Crossref"],
        checks: { total: 3, verified: 1, not_found: 2, not_yet_verified: 0 },
        sources_checked: ["Crossref", "doi.org"],
        references: { total: 2, verified: 2, not_yet_verified: 0, not_found: 0 },
      },
      new Date("2026-11-25T12:00:00Z"),
    );
    expect(text).toContain("It searched Crossref twice");
    expect(text).toContain("It checked 3 references live against Crossref and doi.org: 1 verified and 2 not found.");
    expect(text).toContain("I approved each of the 2 sources in my reference list myself with one click");
    expect(text).toContain("No generative AI was used");
    expect(text).toContain("Generated on 25 November 2026");
  });

  it("does not mention searches, checks or formatting that never happened", () => {
    const text = buildStatement(BASE);
    expect(text).not.toContain("searched");
    expect(text).not.toContain("checked");
    expect(text).not.toContain("APA 7");
    expect(text).toContain("I remain responsible");
  });

  it("discloses unverified references in the list", () => {
    const text = buildStatement({ ...BASE, references: { total: 3, verified: 2, not_yet_verified: 1, not_found: 0 } });
    expect(text).toContain("1 of them is still not yet verified.");
  });
});
