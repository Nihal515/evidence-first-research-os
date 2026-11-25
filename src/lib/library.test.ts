import { describe, expect, it } from "vitest";
import type { Reference } from "../types";
import {
  NO_FILTERS, applyFilters, authorShort, collectionTree, flattenTree, needsAttention, refsForView, sortRefs, viewCounts,
} from "./library";
import { exportable, parseBibtex, parseImport, parseRis, toBibtex, toRis } from "./citations";

const NOW = Date.parse("2026-11-25T12:00:00Z");

function ref(p: Partial<Reference> & { id: string; title: string }): Reference {
  return {
    label: "verified", reason: "", doi: null, authors: [], year: null, container: "", provider: "", csl: null, checks: [],
    retraction: { status: "none_found" }, user_input: {}, checked_at: "2026-11-25T10:00:00Z",
    approved_at: "2026-11-24T10:00:00Z", favorite: false, read_at: null, deleted_at: null, notes: "", abstract: null,
    oa_pdf_url: null, has_uploaded_pdf: false, collection_ids: [], ...p,
  };
}

const LECUN_CSL = {
  id: "10.1038/nature14539", type: "article-journal", title: "Deep learning",
  author: [{ family: "LeCun", given: "Yann" }, { family: "Bengio", given: "Yoshua" }, { family: "Hinton", given: "Geoffrey" }],
  issued: { "date-parts": [[2015, 5, 27]] }, "container-title": "Nature", volume: "521", issue: "7553",
  page: "436-444", DOI: "10.1038/nature14539",
};

const A = ref({ id: "a", title: "Deep learning", authors: ["Yann LeCun", "Yoshua Bengio"], year: 2015, container: "Nature",
  csl: LECUN_CSL, favorite: true, collection_ids: ["c1"], read_at: "2026-11-25T09:00:00Z" });
const B = ref({ id: "b", title: "Attention is all you need", authors: ["Ashish Vaswani"], year: 2017, label: "not_yet_verified",
  approved_at: "2026-10-01T10:00:00Z" });
const C = ref({ id: "c", title: "MMR vaccine study", authors: ["A. Wakefield"], year: 1998, container: "The Lancet",
  retraction: { status: "retracted" } });
const T = ref({ id: "t", title: "Old draft", deleted_at: "2026-11-25T08:00:00Z" });
const ALL = [A, B, C, T];

describe("library views", () => {
  it("filters each sidebar view and keeps Trash separate", () => {
    const ids = (kind: any, extra = {}) => refsForView(ALL, { kind, ...extra }, NOW).map((r) => r.id);
    expect(ids("all")).toEqual(["a", "b", "c"]);
    expect(ids("recent")).toEqual(["a", "c"]); // b was added 55 days ago
    expect(ids("read")).toEqual(["a"]);
    expect(ids("favorites")).toEqual(["a"]);
    expect(ids("unsorted")).toEqual(["b", "c"]);
    expect(ids("attention")).toEqual(["b", "c"]); // not verified, or retracted
    expect(ids("trash")).toEqual(["t"]);
    expect(ids("collection", { collectionId: "c1" })).toEqual(["a"]);
  });

  it("counts views for the sidebar", () => {
    const counts = viewCounts(ALL, [{ id: "c1", name: "Neuro", parent_id: null, created_at: "" }], new Set(["a", "b"]), NOW);
    expect(counts.all).toBe(3);
    expect(counts.trash).toBe(1);
    expect(counts.duplicates).toBe(2);
    expect(counts["c:c1"]).toBe(1);
  });

  it("flags references that need attention", () => {
    expect(needsAttention(A)).toBe(false);
    expect(needsAttention(B)).toBe(true);
    expect(needsAttention(C)).toBe(true);
    expect(needsAttention(ref({ id: "u", title: "x", retraction: { status: "unknown" } }))).toBe(true);
  });
});

describe("search, filters and sorting", () => {
  it("searches title, authors, source and notes, ignoring accents and case", () => {
    const refs = [A, B, ref({ id: "d", title: "Économie", notes: "chapter two" })];
    expect(applyFilters(refs, "lecun", NO_FILTERS).map((r) => r.id)).toEqual(["a"]);
    expect(applyFilters(refs, "economie", NO_FILTERS).map((r) => r.id)).toEqual(["d"]);
    expect(applyFilters(refs, "CHAPTER", NO_FILTERS).map((r) => r.id)).toEqual(["d"]);
    expect(applyFilters(refs, "nature 2015", NO_FILTERS).map((r) => r.id)).toEqual(["a"]);
  });

  it("filters by trust label, retraction, year and unread", () => {
    expect(applyFilters([A, B, C], "", { ...NO_FILTERS, labels: ["not_yet_verified"] }).map((r) => r.id)).toEqual(["b"]);
    expect(applyFilters([A, B, C], "", { ...NO_FILTERS, retractedOnly: true }).map((r) => r.id)).toEqual(["c"]);
    expect(applyFilters([A, B, C], "", { ...NO_FILTERS, yearFrom: 2010, yearTo: 2016 }).map((r) => r.id)).toEqual(["a"]);
    expect(applyFilters([A, B, C], "", { ...NO_FILTERS, unreadOnly: true }).map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("sorts by author family name, year and trust", () => {
    expect(sortRefs([A, B, C], { key: "authors", dir: "asc" }).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortRefs([A, B, C], { key: "year", dir: "desc" }).map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(sortRefs([B, A], { key: "trust", dir: "asc" }).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("shortens author lists the way reference managers do", () => {
    expect(authorShort(["Yann LeCun", "Yoshua Bengio", "Geoffrey Hinton", "Someone Else"])).toBe("LeCun, Y.; Bengio, Y.; Hinton, G.; …");
    expect(authorShort(["Vaswani, A."])).toBe("Vaswani, A.");
    expect(authorShort([])).toBe("—");
  });

  it("builds a nested collection tree", () => {
    const tree = collectionTree([
      { id: "2", name: "Methods", parent_id: "1", created_at: "" },
      { id: "1", name: "Dissertation", parent_id: null, created_at: "" },
      { id: "3", name: "Archive", parent_id: null, created_at: "" },
    ]);
    expect(flattenTree(tree).map((n) => `${n.depth}:${n.name}`)).toEqual(["0:Archive", "0:Dissertation", "1:Methods"]);
  });
});

describe("BibTeX and RIS", () => {
  it("exports Verified references only", () => {
    const { items, excluded } = exportable([A, B]);
    expect(items).toHaveLength(1);
    expect(excluded).toBe(1);
  });

  it("writes BibTeX from the registered metadata", () => {
    const bib = toBibtex([LECUN_CSL]);
    expect(bib).toContain("@article{lecun2015deep,");
    expect(bib).toContain("author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}");
    expect(bib).toContain("journal = {Nature}");
    expect(bib).toContain("pages = {436--444}");
    expect(bib).toContain("doi = {10.1038/nature14539}");
  });

  it("writes RIS from the registered metadata", () => {
    const ris = toRis([LECUN_CSL]);
    expect(ris.split("\r\n")).toEqual(expect.arrayContaining([
      "TY  - JOUR", "TI  - Deep learning", "AU  - LeCun, Yann", "PY  - 2015", "T2  - Nature", "SP  - 436", "EP  - 444",
      "DO  - 10.1038/nature14539", "ER  - ",
    ]));
  });

  it("round-trips its own BibTeX and RIS through the importer", () => {
    for (const parsed of [parseBibtex(toBibtex([LECUN_CSL])), parseRis(toRis([LECUN_CSL]))]) {
      expect(parsed).toEqual([{ title: "Deep learning", authors: "LeCun, Yann; Bengio, Yoshua; Hinton, Geoffrey", year: 2015,
        doi: "10.1038/nature14539" }]);
    }
  });

  it("parses BibTeX written by other tools (Zotero, Mendeley, Google Scholar)", () => {
    const src = `
@comment{exported by a reference manager}
@Article{Vaswani2017,
  Title     = {Attention Is All You Need},
  Author    = {Vaswani, Ashish and Shazeer, Noam},
  Year      = 2017,
  doi       = "https://doi.org/10.48550/arXiv.1706.03762",
}
@book{goodfellow, title={{Deep} Learning}, author={Ian Goodfellow and Yoshua Bengio}, year={2016}, publisher={MIT Press}}
@misc{nodata, note = {no title or doi}}`;
    expect(parseImport("library.bib", src)).toEqual([
      { title: "Attention Is All You Need", authors: "Vaswani, Ashish; Shazeer, Noam", year: 2017, doi: "10.48550/arXiv.1706.03762" },
      { title: "Deep Learning", authors: "Ian Goodfellow; Yoshua Bengio", year: 2016, doi: "" },
    ]);
  });

  it("parses RIS files", () => {
    const src = "TY  - JOUR\nT1  - Reducing the dimensionality of data with neural networks\nA1  - Hinton, G. E.\nA1  - Salakhutdinov, R. R.\nY1  - 2006/07/28\nDO  - 10.1126/science.1127647\nER  - \n";
    expect(parseImport("export.txt", src)).toEqual([{ title: "Reducing the dimensionality of data with neural networks",
      authors: "Hinton, G. E.; Salakhutdinov, R. R.", year: 2006, doi: "10.1126/science.1127647" }]);
  });
});
