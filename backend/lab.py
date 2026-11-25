"""Integrity Lab: we test our own checker in public on a fixed corpus.

Ported from Team 1's Paper Trail Lab (Yashpetkar7/Ai-Club-Hackathon, src/core/lab).
Twelve real controls come from captured Crossref records (lab_seeds.json). Twelve
invented exercises are derived from the first two controls by six fixed
transformations: total fabrication, wrong author, shifted year, swapped DOI,
placeholder, and a plausible extra title clause without a DOI. Cases are never
chosen by whether the checker catches them, and every miss stays visible.

Outcomes (scored against the declared expectation, never fed to the checker):
  correct · expected-retraction · caught · missed · false-alarm · could-not-check
A false acceptance stays a miss even when another lookup failed; a check that
could not fully run is never counted as a success.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional

from .labels import NOT_FOUND, NOT_YET_VERIFIED, VERIFIED
from .records import record_from_crossref

SEEDS = json.loads((Path(__file__).with_name("lab_seeds.json")).read_text(encoding="utf-8"))

FAMILIES = ["real", "total-fabrication", "part-corrupted", "hijacked-identifier", "placeholder", "plausible-missing-title"]
FAMILY_LABELS = {
    "real": "Real controls",
    "total-fabrication": "Total fabrication",
    "part-corrupted": "Part-corrupted",
    "hijacked-identifier": "Hijacked identifier",
    "placeholder": "Placeholder",
    "plausible-missing-title": "Plausible missing title",
}
EXPECTED_TEXT = {
    "metadata-match": "The recorded real metadata should match.",
    "retraction-flag": "The known retraction should be flagged.",
    "reject-invented": "The invented input should not be verified.",
}
MANIFEST = {
    "version": "1",
    "source": "Ported from Team 1's Paper Trail Lab: captured Crossref records (" + SEEDS["fixturePath"] + ", sha256 "
              + SEEDS["fixtureSha256"][:12] + "…).",
    "selection_rule": SEEDS["selectionRule"],
    "generation_rule": ("Keep every selected control. Apply six fixed transformations to each of the first two DOI-sorted "
                        "controls: complete invention, wrong author, wrong year, swapped real DOI, placeholder, and an added "
                        "plausible title clause without a DOI. Never select cases by whether the checker catches them."),
    "limits": [
        "This checks structured reference metadata. It does not test scientific truth or whether a source supports a claim.",
        "This small fixed corpus is not representative of all disciplines, languages or citation formats.",
        "The retracted real control is expected to be flagged; that result is not a false alarm.",
        "Invented references are exercises, never citable sources. A search miss does not prove a work does not exist.",
        "Every miss, unexpected result and unavailable check is kept. Cases are never replaced to improve a score.",
    ],
}


def _clean(title: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", title or "")).strip()


def _raw(title=None, authors=None, year=None, doi=None) -> str:
    parts = [", ".join(authors) if authors else None, f"({year})" if year else None, title,
             f"https://doi.org/{doi}" if doi else None]
    return ". ".join(p for p in parts if p)


def _case(cid, family, title, label, invented, fields, expected, explanation, provenance, mutation=None) -> dict:
    raw = fields.get("raw") or _raw(fields.get("title"), fields.get("authors"), fields.get("year"), fields.get("doi"))
    return {"id": cid, "family": family, "family_label": FAMILY_LABELS[family], "title": title, "label": label,
            "invented": invented, "reference": {**fields, "raw": raw}, "expected": expected,
            "expected_text": EXPECTED_TEXT[expected], "explanation": explanation, "provenance": provenance,
            "mutation": mutation}


def _controls() -> list[dict]:
    out = []
    for entry in SEEDS["entries"]:
        rec = record_from_crossref(entry["record"])
        title = _clean(rec.title)
        retracted = title.upper().startswith("RETRACTED")
        families = [a.split(",")[0].strip() if "," in a else a.split()[-1] for a in rec.authors[:3]]
        if not (rec.doi and title and families and rec.year):
            raise ValueError("A selected real control is missing recorded metadata.")
        out.append(_case(
            f"real:{rec.doi}", "real", title, "Real reference; retracted" if retracted else "Real reference", False,
            {"doi": rec.doi, "title": title, "authors": families, "year": rec.year},
            "retraction-flag" if retracted else "metadata-match",
            "Title, year, DOI and up to three author family names come from the captured Crossref record. "
            "A real reference is not proof that its findings are true.",
            [{"registry": "crossref", "doi": rec.doi, "url": entry["fixtureUrl"]}]))
    return out


def build_corpus() -> list[dict]:
    controls = _controls()
    cases = list(controls)
    adjective, subject = ["Counterfactual", "Imagined"], ["collaborative annotation", "reflective notebooks"]
    for i, base in enumerate(controls[:2]):
        donor, other = controls[i + 2], controls[1 - i]
        f = base["reference"]
        fields = {"title": f["title"], "authors": list(f["authors"]), "year": f["year"], "doi": f["doi"]}
        n = str(i + 1)
        prov = lambda *cs: [p for c in cs for p in c["provenance"]]  # noqa: E731
        cases.append(_case(f"invented:total:{n}", "total-fabrication", "Entirely invented combination",
                           "Invented for this Lab; do not cite", True,
                           {"title": f"{adjective[i]} evidence ledgers for {subject[i]} in learning communities",
                            "authors": [f"LabInventedAuthor{n}"], "year": fields["year"]},
                           "reject-invented", "Code composes a new title and an explicitly invented author. The year is "
                           "borrowed from the control. No DOI or venue is invented.", prov(base),
                           {"method": "compose-reference", "changed": ["title", "authors", "doi"]}))
        cases.append(_case(f"invented:author:{n}", "part-corrupted", "Author attached to the wrong work",
                           "Invented for this Lab; do not cite", True,
                           {**fields, "authors": [donor["reference"]["authors"][0]] + fields["authors"][1:]},
                           "reject-invented", "The first author family name is replaced with one from a different "
                           "captured work. The DOI, title and year still identify the original control.", prov(base, donor),
                           {"method": "replace-author", "changed": ["authors"]}))
        cases.append(_case(f"invented:year:{n}", "part-corrupted", "Year deliberately shifted",
                           "Invented for this Lab; do not cite", True, {**fields, "year": fields["year"] - 7},
                           "reject-invented", "The recorded year is reduced by seven while the original DOI and other "
                           "fields remain.", prov(base), {"method": "shift-year", "changed": ["year"]}))
        cases.append(_case(f"invented:identifier:{n}", "hijacked-identifier", "A real DOI attached to another work",
                           "Invented for this Lab; do not cite", True, {**fields, "doi": other["reference"]["doi"]},
                           "reject-invented", "The DOI is copied from another real control. The exercise invents the "
                           "association, not the identifier.", prov(base, other), {"method": "swap-doi", "changed": ["doi"]}))
        cases.append(_case(f"invented:placeholder:{n}", "placeholder", "Unfinished reference placeholder",
                           "Invented for this Lab; do not cite", True, {"raw": "[ citation needed ]" if i == 0 else "TODO"},
                           "reject-invented", "This generated placeholder has too little reference information to search. "
                           "It is not a real source.", [], {"method": "placeholder", "changed": ["raw"]}))
        addition = ["a replication across learning communities", "a comparison of classroom settings"][i]
        no_doi = {k: v for k, v in fields.items() if k != "doi"}
        cases.append(_case(f"invented:plausible-title:{n}", "plausible-missing-title",
                           "Plausible title with invented extra wording", "Invented for this Lab; do not cite", True,
                           {**no_doi, "title": f"{fields['title']}: {addition}"}, "reject-invented",
                           "Code adds a plausible clause absent from the captured title and removes the DOI.", prov(base),
                           {"method": "append-title", "changed": ["title", "doi"]}))
    return cases


CORPUS = build_corpus()
BY_ID = {c["id"]: c for c in CORPUS}


def check_input(case: dict) -> dict:
    """The checker input for a case: structured fields, or raw text for a placeholder."""
    r = case["reference"]
    if "title" not in r and "doi" not in r:
        return {"mode": "text", "text": r["raw"]}
    return {"mode": "fields", "title": r.get("title", ""), "authors": "; ".join(r.get("authors") or []),
            "year": r.get("year"), "doi": r.get("doi", "")}


def evaluate(case: dict, label: Optional[str], *, refused: bool = False, unavailable: bool = False,
             retraction: Optional[str] = None) -> dict:
    """Score one checker result against the case's declared expectation."""
    def out(outcome: str, text: str) -> dict:
        return {"outcome": outcome, "text": text, "limited_coverage": bool(unavailable)}

    expected = case["expected"]
    if refused:
        if expected == "reject-invented":
            return out("caught", "Refused: too little to check, so it cannot be added")
        return out("false-alarm", "A real reference was refused as input")
    # A false acceptance is a miss even when another lookup failed.
    if label == VERIFIED and expected == "reject-invented":
        return out("missed", "Missed: the invented reference was labelled Verified")
    if expected == "retraction-flag":
        if label == VERIFIED and retraction == "retracted":
            return out("expected-retraction", "Expected retraction found")
        if label == VERIFIED and retraction in (None, "unknown"):
            return out("could-not-check", "Could not check the retraction; unresolved")
        if label == VERIFIED:
            return out("missed", "Missed the known retraction")
        if label == NOT_YET_VERIFIED:
            return out("could-not-check", "Could not check; unresolved")
        return out("false-alarm", "A real (retracted) control was labelled Not found")
    if label == NOT_YET_VERIFIED:
        return out("could-not-check", "Could not check; unresolved, never counted as a success")
    if expected == "metadata-match":
        if label == VERIFIED:
            return out("correct", "Real control matched")
        return out("false-alarm", "False alarm: a real control was labelled Not found")
    if label == NOT_FOUND:
        return out("caught", "Flagged the invented input; inspect the reason")
    return out("could-not-check", "Unscored checker result; unresolved")
