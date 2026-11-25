"""Live reference verification with fail-closed trust labels.

Rules (the "fake reference test"):

* ``verified``         – only when a live record from Crossref, doi.org or
                         OpenAlex matches every field the user supplied.
* ``not_found``        – the DOI is not registered, or no record matches the
                         details entered, in the databases that answered.
* ``not_yet_verified`` – the live check could not run (timeout, rate limit,
                         outage) or could not read the record's details.

There is no code path that returns ``verified`` without a matching live record.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import httpx

from . import providers as p
from .labels import NOT_FOUND, NOT_YET_VERIFIED, VERIFIED
from .records import (
    TITLE_ONLY_MATCH,
    FieldCheck,
    Record,
    all_match,
    compare_fields,
    compare_raw,
    extract_doi,
    norm,
    normalize_doi,
    record_from_crossref,
    record_from_csl,
    record_from_openalex,
    title_similarity,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class VerifyResult:
    label: str
    reason: str
    checks: list[FieldCheck] = field(default_factory=list)
    sources_checked: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)
    record: Optional[Record] = None
    checked_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "reason": self.reason,
            "checks": [c.to_dict() for c in self.checks],
            "sources_checked": self.sources_checked,
            "unavailable": self.unavailable,
            "record": self.record.summary() if self.record else None,
            "checked_at": self.checked_at,
        }


def _who(rec: Record) -> str:
    names = ", ".join(rec.authors[:3]) + (" et al." if len(rec.authors) > 3 else "")
    year = f" ({rec.year})" if rec.year else ""
    return f"“{rec.title}”{year}" + (f" by {names}" if names else "")


def _unavailable_note(unavailable: list[str]) -> str:
    return f" ({'; '.join(unavailable)} could not be checked.)" if unavailable else ""


def _mismatch(checks: list[FieldCheck]) -> str:
    """'title does not match', 'authors do not match', 'title and year do not match'."""
    bad = [c.field.lower() for c in checks if c.status == "mismatch"]
    if not bad:
        return "details do not match"
    words = bad[0] if len(bad) == 1 else ", ".join(bad[:-1]) + " and " + bad[-1]
    plural = len(bad) > 1 or bad[0] == "authors"
    return f"{words} {'do' if plural else 'does'} not match"


def _better(candidate, current) -> bool:
    """Prefer the near-miss that matches the most fields."""
    score = lambda checks: sum(1 for c in checks if c.status == "match")
    return current is None or score(candidate[1]) > score(current[1])


# ------------------------------------------------------------------ DOI lookups
def fetch_by_doi(client: httpx.Client, doi: str):
    """Look a DOI up live. Returns (status, record, sources_checked, unavailable).

    status: "ok" | "not_registered" | "unavailable" | "no_metadata"
    """
    sources: list[str] = []
    unavailable: list[str] = []

    cr = p.crossref_work(client, doi)
    if cr.status == p.OK:
        return "ok", record_from_crossref(cr.data), ["Crossref"], unavailable
    if cr.status == p.NOT_FOUND:
        sources.append("Crossref")
    else:
        unavailable.append(f"Crossref: {cr.detail}")
        oa = p.openalex_by_doi(client, doi)
        if oa.status == p.OK:
            return "ok", record_from_openalex(oa.data), sources + ["OpenAlex"], unavailable
        if oa.status == p.NOT_FOUND:
            sources.append("OpenAlex")
        else:
            unavailable.append(f"OpenAlex: {oa.detail}")

    reg = p.doi_registered(client, doi)
    if reg.status == p.NOT_FOUND:
        return "not_registered", None, sources + ["doi.org"], unavailable
    if reg.status == p.UNAVAILABLE:
        unavailable.append(f"doi.org: {reg.detail}")
        return "unavailable", None, sources, unavailable

    # Registered with another agency (for example DataCite): read its metadata.
    sources.append("doi.org")
    csl = p.doi_csl(client, doi)
    if csl.status == p.OK:
        return "ok", record_from_csl(csl.data, provider="doi.org"), sources, unavailable
    if "OpenAlex" not in sources:
        oa = p.openalex_by_doi(client, doi)
        if oa.status == p.OK:
            return "ok", record_from_openalex(oa.data), sources + ["OpenAlex"], unavailable
    unavailable.append(f"doi.org metadata: {csl.detail or 'not readable'}")
    return "no_metadata", None, sources, unavailable


def _doi_outcome(status, doi, sources, unavailable) -> Optional[VerifyResult]:
    if status == "not_registered":
        return VerifyResult(
            NOT_FOUND,
            f"The DOI {doi} is not registered with doi.org, so this reference does not exist as entered.",
            [FieldCheck("DOI", "mismatch", "Not registered with doi.org")],
            sources, unavailable,
        )
    if status == "unavailable":
        return VerifyResult(
            NOT_YET_VERIFIED,
            "The live check could not run right now, so this reference is not yet verified. Try again in a moment."
            + _unavailable_note(unavailable),
            [FieldCheck("DOI", "not_provided", "Could not be checked")],
            sources, unavailable,
        )
    if status == "no_metadata":
        return VerifyResult(
            NOT_YET_VERIFIED,
            "The DOI is registered, but its details could not be read to compare with what you entered.",
            [FieldCheck("DOI", "match", "Registered with doi.org")],
            sources, unavailable,
        )
    return None


# ------------------------------------------------------------------ structured input
def verify_fields(client: httpx.Client, *, title: str = "", authors: str = "", year: Optional[int] = None,
                  doi: str = "") -> VerifyResult:
    title, authors, doi = (title or "").strip(), (authors or "").strip(), (doi or "").strip()

    if doi:
        doi_n = normalize_doi(doi)
        if not doi_n:
            return VerifyResult(
                NOT_FOUND,
                "That is not a valid DOI (a DOI looks like 10.1234/abcd), so it cannot identify a real work.",
                [FieldCheck("DOI", "mismatch", "Invalid DOI format")],
            )
        status, rec, sources, unavailable = fetch_by_doi(client, doi_n)
        outcome = _doi_outcome(status, doi_n, sources, unavailable)
        if outcome:
            return outcome
        checks = compare_fields(rec, title=title, authors=authors, year=year, doi=doi_n)
        if all_match(checks):
            entered = [c.field.lower() for c in checks if c.status == "match" and c.field != "DOI"]
            extra = f" and the {', '.join(entered)} you entered match{'es' if len(entered) == 1 else ''}" if entered else ""
            return VerifyResult(VERIFIED, f"Matched live: the DOI resolves to {_who(rec)}{extra}.",
                                checks, sources, unavailable, rec)
        return VerifyResult(
            NOT_FOUND,
            f"The DOI is real, but its registered {_mismatch(checks)} what you entered. "
            f"It belongs to {_who(rec)}. This reference, as entered, could not be verified.",
            checks, sources, unavailable, rec,
        )

    if not title:
        raise ValueError("Enter a title or a DOI to check.")

    year_part = str(year) if year else ""
    query = " ".join(x for x in (title, authors, year_part) if x)
    sources: list[str] = []
    unavailable: list[str] = []
    near: Optional[tuple[Record, list[FieldCheck]]] = None
    title_only = not authors and not year

    def evaluate(records: list[Record]) -> Optional[VerifyResult]:
        nonlocal near
        for rec in records:
            checks = compare_fields(rec, title=title, authors=authors, year=year)
            if title_only and title_similarity(title, rec) < TITLE_ONLY_MATCH:
                continue
            if all_match(checks):
                note = " Only the title was checked — add the author and year for a stronger check." if title_only else ""
                return VerifyResult(VERIFIED, f"Matched live in {rec.provider}: {_who(rec)}.{note}",
                                    checks, list(sources), list(unavailable), rec)
            if any(c.field == "Title" and c.status == "match" for c in checks) and _better((rec, checks), near):
                near = (rec, checks)
        return None

    cr = p.crossref_search(client, query)
    if cr.status == p.OK:
        sources.append("Crossref")
        found = evaluate([record_from_crossref(i) for i in cr.data if i.get("title")])
        if found:
            return found
    else:
        unavailable.append(f"Crossref: {cr.detail}")

    oa = p.openalex_search(client, " ".join(x for x in (title, authors) if x))
    if oa.status == p.OK:
        sources.append("OpenAlex")
        found = evaluate([record_from_openalex(w) for w in cr_safe(oa.data) if w.get("display_name")])
        if found:
            return found
    else:
        unavailable.append(f"OpenAlex: {oa.detail}")

    if not sources:
        return VerifyResult(
            NOT_YET_VERIFIED,
            "The live check could not run right now, so this reference is not yet verified. Try again in a moment."
            + _unavailable_note(unavailable),
            [], sources, unavailable,
        )
    if near:
        rec, checks = near
        return VerifyResult(
            NOT_FOUND,
            f"A work with this title exists, but its {_mismatch(checks)}: {_who(rec)}. "
            "This reference, as entered, could not be verified.",
            checks, sources, unavailable, rec,
        )
    return VerifyResult(
        NOT_FOUND,
        f"No record matching this title was found in {' or '.join(sources)}. It may not exist."
        + _unavailable_note(unavailable),
        [FieldCheck("Title", "mismatch", "No matching record")], sources, unavailable,
    )


def cr_safe(items):
    return [i for i in items or [] if isinstance(i, dict)]


# ------------------------------------------------------------------ pasted citation
def verify_text(client: httpx.Client, text: str) -> VerifyResult:
    text = (text or "").strip()
    if len(norm(text).split()) < 2 and not extract_doi(text):
        raise ValueError("Paste a full reference (authors, year, title) or a DOI.")

    doi = extract_doi(text)
    if doi:
        status, rec, sources, unavailable = fetch_by_doi(client, doi)
        outcome = _doi_outcome(status, doi, sources, unavailable)
        if outcome:
            return outcome
        rest = re.sub(r"(https?://)?(dx\.)?doi\.org/|\bdoi\b:?", " ", text, flags=re.IGNORECASE)
        rest = rest.lower().replace(doi, " ")
        if len(norm(rest).split()) >= 3:
            checks = [FieldCheck("DOI", "match", f"{doi} is registered")] + compare_raw(rec, rest)
            if not all_match(checks):
                return VerifyResult(
                    NOT_FOUND,
                    f"The DOI is real, but its registered {_mismatch(checks)} the reference. "
                    f"It belongs to {_who(rec)}.",
                    checks, sources, unavailable, rec,
                )
        else:
            checks = [FieldCheck("DOI", "match", f"{doi} is registered")]
        return VerifyResult(VERIFIED, f"Matched live: the DOI resolves to {_who(rec)}.", checks, sources, unavailable, rec)

    sources: list[str] = []
    unavailable: list[str] = []
    near = None
    for fetch, build, name in (
        (lambda: p.crossref_search(client, text), record_from_crossref, "Crossref"),
        (lambda: p.openalex_search(client, text[:300]), record_from_openalex, "OpenAlex"),
    ):
        res = fetch()
        if res.status != p.OK:
            unavailable.append(f"{name}: {res.detail}")
            continue
        sources.append(name)
        key = "title" if name == "Crossref" else "display_name"
        for item in cr_safe(res.data):
            if not item.get(key):
                continue
            rec = build(item)
            checks = compare_raw(rec, text)
            if all_match(checks) and checks[0].status == "match":
                return VerifyResult(VERIFIED, f"Matched live in {name}: {_who(rec)}.", checks, list(sources), list(unavailable), rec)
            if checks[0].status == "match" and _better((rec, checks), near):
                near = (rec, checks)
    if not sources:
        return VerifyResult(
            NOT_YET_VERIFIED,
            "The live check could not run right now, so this reference is not yet verified. Try again in a moment."
            + _unavailable_note(unavailable),
            [], sources, unavailable,
        )
    if near:
        rec, checks = near
        return VerifyResult(
            NOT_FOUND,
            f"A work with this title exists, but its {_mismatch(checks)}: {_who(rec)}.",
            checks, sources, unavailable, rec,
        )
    return VerifyResult(
        NOT_FOUND,
        f"No matching record was found in {' or '.join(sources)}. It may not exist." + _unavailable_note(unavailable),
        [FieldCheck("Title", "mismatch", "No matching record")], sources, unavailable,
    )


# ------------------------------------------------------------------ search and retractions
def search(client: httpx.Client, query: str) -> dict:
    cr = p.crossref_search(client, query)
    if cr.status == p.OK:
        records = [record_from_crossref(i) for i in cr.data if i.get("title")]
        return {"status": "ok", "provider": "Crossref", "records": records, "retrieved_at": now_iso()}
    oa = p.openalex_search(client, query)
    if oa.status == p.OK:
        records = [record_from_openalex(w) for w in cr_safe(oa.data) if w.get("display_name")]
        return {"status": "ok", "provider": "OpenAlex", "records": records, "retrieved_at": now_iso(),
                "note": f"Crossref could not be reached ({cr.detail}); results are from OpenAlex."}
    return {"status": "unavailable", "provider": None, "records": [], "retrieved_at": now_iso(),
            "note": f"Search could not run right now (Crossref: {cr.detail}; OpenAlex: {oa.detail}). Try again."}


RETRACTED = {"retraction", "partial_retraction", "withdrawal", "removal"}
CONCERN = {"expression_of_concern"}
CORRECTED = {"correction", "erratum", "corrigendum", "addendum", "clarification"}


def retraction_status(client: httpx.Client, doi: Optional[str]) -> dict:
    if not doi:
        return {"status": "unknown", "detail": "No DOI, so retraction status could not be checked."}
    res = p.crossref_updates(client, doi)
    if res.status != p.OK:
        return {"status": "unknown",
                "detail": "Retraction status could not be checked right now. It is unknown, not cleared."}
    notices = []
    for item in cr_safe(res.data):
        for upd in item.get("update-to") or []:
            if (upd.get("DOI") or "").lower() == doi.lower():
                date = ((upd.get("updated") or {}).get("date-time") or "")[:10]
                notices.append({"type": upd.get("type") or "", "label": upd.get("label") or upd.get("type") or "",
                                "notice_doi": (item.get("DOI") or "").lower(), "date": date,
                                "source": upd.get("source") or ""})
    types = {n["type"] for n in notices}
    if types & RETRACTED:
        n = next(x for x in notices if x["type"] in RETRACTED)
        return {"status": "retracted", "detail": f"Retracted ({n['date'] or 'date unknown'}). Notice: https://doi.org/{n['notice_doi']}",
                "notices": notices}
    if types & CONCERN:
        return {"status": "concern", "detail": "An expression of concern has been published about this work.", "notices": notices}
    if types & CORRECTED:
        return {"status": "corrected", "detail": "A correction has been published for this work.", "notices": notices}
    return {"status": "none_found",
            "detail": "No retraction or correction notice found in Crossref (which includes Retraction Watch data)."}
