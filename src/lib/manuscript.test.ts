import { describe, expect, it } from "vitest";
import { analyse, findCitations, matchCitation, splitReferences } from "./manuscript";

const DRAFT = [
  "Working from home and performance",
  "Introduction",
  "Home working lifted performance by 31% in one experiment (Bloom et al., 2015).",
  "LeCun et al. (2015) describe deep learning; others disagree (Smith & Jones, 2020; Hargrove, 2024).",
  "Generative AI raised writing productivity (Noy & Zhang, 2023, p. 187).",
  "References",
  "Bloom, N., Liang, J., Roberts, J., & Ying, Z. J. (2015). Does working from home work? Evidence from a Chinese experiment. The Quarterly Journal of Economics, 130(1), 165–218. https://doi.org/10.1093/qje/qju032",
  "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539",
  "Noy, S., & Zhang, W. (2023). Experimental evidence on the productivity effects of generative artificial intelligence. Science, 381(6654), 187–192.",
  "Unused, A. (2019). A reference nobody cites in the text at all. Journal of Examples, 1(1), 1–2.",
  "Appendix A",
  "Survey items",
];

describe("reading a paper", () => {
  it("finds the reference list under its heading and stops at the appendix", () => {
    const p = analyse("draft.docx", "docx", DRAFT);
    expect(p.heading).toBe("References");
    expect(p.references).toHaveLength(4);
    expect(p.references[0]).toMatch(/^Bloom, N\./);
    expect(p.references.some((r) => r.includes("Survey items"))).toBe(false);
  });

  it("finds parenthetical, multiple and narrative citations with page numbers", () => {
    const c = findCitations(DRAFT.slice(0, 5));
    const keys = c.map((x) => `${x.surname} ${x.year}`);
    expect(keys).toEqual(expect.arrayContaining(["Bloom 2015", "Smith 2020", "Hargrove 2024", "Noy 2023", "LeCun 2015"]));
    expect(c.find((x) => x.surname === "Bloom")!.sentence).toMatch(/^Home working lifted performance by 31%/);
  });

  it("cross-checks citations against the list", () => {
    const p = analyse("draft.docx", "docx", DRAFT);
    const bloom = p.citations.find((x) => x.surname === "Bloom")!;
    const smith = p.citations.find((x) => x.surname === "Smith")!;
    expect(matchCitation(bloom, p.references, p.numbered)).toEqual([0]);
    expect(matchCitation(smith, p.references, p.numbered)).toEqual([]); // cited but not in the list
    const cited = new Set(p.citations.flatMap((c) => matchCitation(c, p.references, p.numbered)));
    expect(cited.has(3)).toBe(false); // in the list but never cited
  });

  it("joins wrapped PDF lines into one reference each", () => {
    const lines = [
      "Bloom, N., Liang, J., Roberts, J., & Ying, Z. J. (2015). Does working from home",
      "work? Evidence from a Chinese experiment. The Quarterly Journal of Economics,",
      "130(1), 165–218. https://doi.org/10.1093/qje/qju032",
      "12",
      "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553),",
      "436–444.",
    ];
    const refs = splitReferences(lines, true);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatch(/Chinese experiment\. The Quarterly Journal of Economics, 130\(1\)/);
  });

  it("finds a citation split over two PDF lines", () => {
    const p = analyse("draft.pdf", "pdf", ["Introduction", "Generative AI tools raised the speed of professional writing tasks (Noy &",
      "Zhang, 2023). Deep learning has transformed recognition (LeCun et al., 2015).", "References",
      "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444.",
      "Noy, S., & Zhang, W. (2023). Experimental evidence on the productivity effects of generative AI. Science, 381, 187–192."]);
    expect(p.citations.map((c) => c.surname)).toEqual(expect.arrayContaining(["Noy", "LeCun"]));
    expect(p.citations.find((c) => c.surname === "Noy")!.sentence).toMatch(/^Generative AI tools raised/);
  });

  it("matches numbered references and [n] citations", () => {
    const p = analyse("paper.pdf", "pdf", ["Results agree with earlier work [1, 2].", "References",
      "[1] LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521, 436–444.",
      "[2] Bloom, N. et al. (2015). Does working from home work? QJE, 130(1), 165–218."]);
    expect(p.numbered).toBe(true);
    expect(matchCitation(p.citations[0]!, p.references, p.numbered)).toEqual([0, 1]);
  });
});
