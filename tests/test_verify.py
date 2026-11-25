"""Unit tests for the verification engine, using recorded provider responses.

The key property: a reference is labelled Verified only when a live record
matches it. Every failure path must give Not found or Not yet verified.
"""
import itertools
import json
from pathlib import Path

import pytest

from backend import providers as p
from backend import verify as v
from backend.labels import NOT_FOUND, NOT_YET_VERIFIED, VERIFIED
from backend.records import (
    compare_fields,
    extract_doi,
    normalize_doi,
    record_from_crossref,
    user_name_tokens,
)

FIX = Path(__file__).parent / "fixtures"
LECUN = json.loads((FIX / "crossref_lecun_2015.json").read_text())
WAKEFIELD_UPDATES = json.loads((FIX / "crossref_updates_wakefield.json").read_text())
LECUN_DOI = "10.1038/nature14539"
UNRELATED = {
    "DOI": "10.1080/07370008.2021.1972423",
    "title": ["Teacher Responsiveness that Promotes Equity in Secondary Science Classrooms"],
    "author": [{"given": "A", "family": "Researcher"}],
    "issued": {"date-parts": [[2021]]},
    "type": "journal-article",
}


class Fake:
    """Programmable stand-in for the provider adapters."""

    def __init__(self, monkeypatch, *, work=None, handle=p.NOT_FOUND, csl=None, search=None,
                 oa_doi=p.NOT_FOUND, oa_search=None, updates=None, open_access=p.NOT_FOUND):
        self.work, self.handle, self.csl = work, handle, csl
        self.open_access = open_access
        self.search_res, self.oa_doi, self.oa_search = search, oa_doi, oa_search
        self.updates = updates
        monkeypatch.setattr(p, "crossref_work", self._work)
        monkeypatch.setattr(p, "doi_registered", lambda c, d: p.ProviderResult(self.handle, "doi.org", detail="x"))
        monkeypatch.setattr(p, "doi_csl", self._csl)
        monkeypatch.setattr(p, "crossref_search", self._search)
        monkeypatch.setattr(p, "openalex_by_doi", self._oa_doi)
        monkeypatch.setattr(p, "openalex_search", self._oa_search)
        monkeypatch.setattr(p, "crossref_updates", self._updates)
        monkeypatch.setattr(p, "openalex_open_access", self._open_access)

    def _open_access(self, c, doi):
        if isinstance(self.open_access, dict):
            return p.ProviderResult(p.OK, "OpenAlex", self.open_access)
        return p.ProviderResult(self.open_access, "OpenAlex", detail="x")

    def _work(self, c, doi):
        if self.work == p.UNAVAILABLE:
            return p.ProviderResult(p.UNAVAILABLE, "Crossref", detail="rate limited")
        if isinstance(self.work, dict) and self.work.get("DOI", "").lower() == doi:
            return p.ProviderResult(p.OK, "Crossref", self.work)
        return p.ProviderResult(p.NOT_FOUND, "Crossref")

    def _csl(self, c, doi):
        if isinstance(self.csl, dict):
            return p.ProviderResult(p.OK, "doi.org", self.csl)
        return p.ProviderResult(p.UNAVAILABLE, "doi.org", detail="no metadata")

    def _search(self, c, q, rows=10):
        if self.search_res == p.UNAVAILABLE:
            return p.ProviderResult(p.UNAVAILABLE, "Crossref", detail="rate limited")
        return p.ProviderResult(p.OK, "Crossref", self.search_res or [])

    def _oa_doi(self, c, doi):
        if self.oa_doi == p.UNAVAILABLE:
            return p.ProviderResult(p.UNAVAILABLE, "OpenAlex", detail="timeout")
        return p.ProviderResult(p.NOT_FOUND, "OpenAlex")

    def _oa_search(self, c, q, rows=10):
        if self.oa_search == p.UNAVAILABLE:
            return p.ProviderResult(p.UNAVAILABLE, "OpenAlex", detail="timeout")
        return p.ProviderResult(p.OK, "OpenAlex", self.oa_search or [])

    def _updates(self, c, doi):
        if self.updates == p.UNAVAILABLE:
            return p.ProviderResult(p.UNAVAILABLE, "Crossref", detail="rate limited")
        return p.ProviderResult(p.OK, "Crossref", self.updates or [])


# ------------------------------------------------------------------ helpers
@pytest.mark.parametrize("raw,expected", [
    ("10.1038/nature14539", LECUN_DOI),
    ("https://doi.org/10.1038/NATURE14539", LECUN_DOI),
    ("doi:10.1038/nature14539.", LECUN_DOI),
    ("http://dx.doi.org/10.1038/nature14539", LECUN_DOI),
    ("nature14539", None),
    ("11.1038/nature14539", None),
    ("", None),
])
def test_normalize_doi(raw, expected):
    assert normalize_doi(raw) == expected


def test_extract_doi_from_citation():
    text = "LeCun, Y. (2015). Deep learning. Nature, 521(7553), 436-444. https://doi.org/10.1038/nature14539."
    assert extract_doi(text) == LECUN_DOI


@pytest.mark.parametrize("authors,tokens", [
    ("LeCun, Y., Bengio, Y., & Hinton, G.", ["lecun", "bengio", "hinton"]),
    ("Yann LeCun; Yoshua Bengio; Geoffrey Hinton", ["yann", "lecun", "yoshua", "bengio", "geoffrey", "hinton"]),
    ("LeCun Y, Bengio Y, Hinton GE", ["lecun", "bengio", "hinton"]),
    ("Y.B. Smith et al.", ["smith"]),
    ("J.-P. van der Berg", ["berg"]),
])
def test_user_name_tokens(authors, tokens):
    assert user_name_tokens(authors) == tokens


def test_compare_fields_all_match():
    rec = record_from_crossref(LECUN)
    checks = compare_fields(rec, title="Deep learning", authors="LeCun, Y., Bengio, Y., & Hinton, G.", year=2015)
    assert [c.status for c in checks] == ["match", "match", "match"]


@pytest.mark.parametrize("kwargs,field", [
    ({"title": "Deep learning", "authors": "John Fakeman", "year": 2015}, "Authors"),
    ({"title": "Deep learning", "authors": "LeCun, Y., & Fakeman, J.", "year": 2015}, "Authors"),
    ({"title": "Deep learning", "authors": "LeCun", "year": 2019}, "Year"),
    ({"title": "Quantum bananas in Martian classrooms", "authors": "LeCun", "year": 2015}, "Title"),
])
def test_compare_fields_mismatch(kwargs, field):
    rec = record_from_crossref(LECUN)
    checks = {c.field: c.status for c in compare_fields(rec, **kwargs)}
    assert checks[field] == "mismatch"


# ------------------------------------------------------------------ DOI path
def test_real_doi_matching_details_is_verified(monkeypatch):
    Fake(monkeypatch, work=LECUN)
    r = v.verify_fields(None, title="Deep learning", authors="LeCun, Y.", year=2015, doi=LECUN_DOI)
    assert r.label == VERIFIED and r.record.doi == LECUN_DOI


def test_doi_only_is_verified_when_registered(monkeypatch):
    Fake(monkeypatch, work=LECUN)
    assert v.verify_fields(None, doi="https://doi.org/10.1038/nature14539").label == VERIFIED


def test_fake_doi_is_not_found(monkeypatch):
    Fake(monkeypatch, work=None, handle=p.NOT_FOUND)
    r = v.verify_fields(None, title="A made-up paper", doi="10.1234/fake-doi-2026")
    assert r.label == NOT_FOUND and "not registered" in r.reason


def test_invalid_doi_format_is_not_found(monkeypatch):
    Fake(monkeypatch)
    assert v.verify_fields(None, doi="not-a-doi").label == NOT_FOUND


def test_real_doi_with_made_up_title_is_not_found(monkeypatch):
    Fake(monkeypatch, work=LECUN)
    r = v.verify_fields(None, title="Neural bananas for quantum classrooms", doi=LECUN_DOI)
    assert r.label == NOT_FOUND and "belongs to" in r.reason


def test_real_doi_with_made_up_author_is_not_found(monkeypatch):
    Fake(monkeypatch, work=LECUN)
    r = v.verify_fields(None, title="Deep learning", authors="Priya Inventedname", doi=LECUN_DOI)
    assert r.label == NOT_FOUND


def test_crossref_down_and_registry_down_is_not_yet_verified(monkeypatch):
    Fake(monkeypatch, work=p.UNAVAILABLE, oa_doi=p.UNAVAILABLE, handle=p.UNAVAILABLE)
    r = v.verify_fields(None, title="Deep learning", doi=LECUN_DOI)
    assert r.label == NOT_YET_VERIFIED


def test_registered_doi_without_readable_metadata_is_not_yet_verified(monkeypatch):
    Fake(monkeypatch, work=None, handle=p.OK, csl=None, oa_doi=p.UNAVAILABLE)
    assert v.verify_fields(None, title="Some dataset", doi="10.5281/zenodo.1234567").label == NOT_YET_VERIFIED


def test_datacite_doi_verified_through_doi_org(monkeypatch):
    csl = {"type": "dataset", "title": "Climate observations 2020", "DOI": "10.5281/zenodo.1234567",
           "author": [{"family": "Rahman", "given": "Aisha"}], "issued": {"date-parts": [[2020]]}}
    Fake(monkeypatch, work=None, handle=p.OK, csl=csl)
    r = v.verify_fields(None, title="Climate observations 2020", authors="Rahman, A.", doi="10.5281/zenodo.1234567")
    assert r.label == VERIFIED and r.record.provider == "doi.org"


# ------------------------------------------------------------------ title / author / year path
def test_real_reference_without_doi_is_verified(monkeypatch):
    Fake(monkeypatch, search=[UNRELATED, LECUN])
    r = v.verify_fields(None, title="Deep learning", authors="LeCun, Bengio, Hinton", year=2015)
    assert r.label == VERIFIED and r.record.doi == LECUN_DOI


def test_made_up_title_and_author_is_not_found(monkeypatch):
    Fake(monkeypatch, search=[UNRELATED], oa_search=[])
    r = v.verify_fields(None, title="Quantum banana cognition in Martian classrooms", authors="Zxqvort, T.", year=2024)
    assert r.label == NOT_FOUND


def test_real_title_with_made_up_author_is_not_found(monkeypatch):
    Fake(monkeypatch, search=[LECUN], oa_search=[])
    r = v.verify_fields(None, title="Deep learning", authors="Fakeman, J.", year=2015)
    assert r.label == NOT_FOUND and "A work with this title exists" in r.reason


def test_real_title_with_wrong_year_is_not_found(monkeypatch):
    Fake(monkeypatch, search=[LECUN], oa_search=[])
    assert v.verify_fields(None, title="Deep learning", authors="LeCun", year=2009).label == NOT_FOUND


def test_title_only_needs_near_exact_match(monkeypatch):
    long_title = dict(LECUN, title=["Deep learning for protein structure prediction at scale"])
    Fake(monkeypatch, search=[long_title], oa_search=[])
    assert v.verify_fields(None, title="Deep learning for protein structure prediction at scale").label == VERIFIED
    assert v.verify_fields(None, title="Deep learning for protein structure prediction in classrooms").label == NOT_FOUND


def test_short_title_alone_cannot_verify(monkeypatch):
    """'Deep learning' fits many works (LeCun 2015, Goodfellow 2016...): a two-word title on
    its own is not enough evidence, typed or pasted."""
    Fake(monkeypatch, search=[LECUN], oa_search=[])
    r = v.verify_fields(None, title="Deep learning")
    assert r.label == NOT_YET_VERIFIED and "short title" in r.reason
    no_authors = dict(LECUN, title=["Learning to cite"], author=[])
    Fake(monkeypatch, search=[no_authors], oa_search=[])
    r = v.verify_text(None, "Learning to cite. A short note.")  # title matches; nothing else can be compared
    assert r.label == NOT_YET_VERIFIED and "Add the author and year" in r.reason
    Fake(monkeypatch, search=[LECUN], oa_search=[])
    # with the author or year it verifies as before
    assert v.verify_fields(None, title="Deep learning", authors="LeCun", year=2015).label == VERIFIED


@pytest.mark.parametrize("text", ["[citation needed]", "[ citation needed ]", "TODO", "(Author, Year)", "???", "TBD."])
def test_placeholders_are_refused(text):
    with pytest.raises(ValueError, match="placeholder|full reference"):
        v.verify_text(None, text)


def test_search_unavailable_everywhere_is_not_yet_verified(monkeypatch):
    Fake(monkeypatch, search=p.UNAVAILABLE, oa_search=p.UNAVAILABLE)
    r = v.verify_fields(None, title="Deep learning", authors="LeCun", year=2015)
    assert r.label == NOT_YET_VERIFIED


def test_missing_title_and_doi_is_rejected(monkeypatch):
    Fake(monkeypatch)
    with pytest.raises(ValueError):
        v.verify_fields(None, authors="LeCun")


# ------------------------------------------------------------------ pasted citations
APA_LECUN = "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444."


def test_pasted_real_citation_is_verified(monkeypatch):
    Fake(monkeypatch, search=[UNRELATED, LECUN])
    assert v.verify_text(None, APA_LECUN).label == VERIFIED


def test_pasted_citation_with_fake_author_is_not_found(monkeypatch):
    Fake(monkeypatch, search=[LECUN], oa_search=[])
    r = v.verify_text(None, "Fakeman, J. (2015). Deep learning. Nature, 521, 436–444.")
    assert r.label == NOT_FOUND


def test_pasted_made_up_citation_is_not_found(monkeypatch):
    Fake(monkeypatch, search=[UNRELATED], oa_search=[])
    r = v.verify_text(None, "Zxqvort, T. (2024). Quantum banana cognition in Martian classrooms. Journal of Imaginary Studies, 3, 1–9.")
    assert r.label == NOT_FOUND


def test_pasted_doi_link_only_is_verified(monkeypatch):
    Fake(monkeypatch, work=LECUN)
    assert v.verify_text(None, "https://doi.org/10.1038/nature14539").label == VERIFIED


def test_pasted_fake_doi_is_not_found(monkeypatch):
    Fake(monkeypatch, work=None, handle=p.NOT_FOUND)
    assert v.verify_text(None, "Smith, J. (2020). Fake study. https://doi.org/10.9999/made.up.2020").label == NOT_FOUND


def test_pasted_real_doi_with_wrong_title_is_not_found(monkeypatch):
    Fake(monkeypatch, work=LECUN)
    r = v.verify_text(None, "Smith, J. (2020). Bananas and robots in schools. https://doi.org/10.1038/nature14539")
    assert r.label == NOT_FOUND


# ------------------------------------------------------------------ the fail-closed property
def test_never_verified_without_a_matching_record(monkeypatch):
    """Across every combination of provider outcomes, a made-up reference is never Verified."""
    outcomes = {
        "work": [None, p.UNAVAILABLE],
        "handle": [p.NOT_FOUND, p.UNAVAILABLE, p.OK],
        "search": [[UNRELATED], [], p.UNAVAILABLE],
        "oa_search": [[], p.UNAVAILABLE],
        "oa_doi": [p.NOT_FOUND, p.UNAVAILABLE],
    }
    keys = list(outcomes)
    for combo in itertools.product(*outcomes.values()):
        Fake(monkeypatch, **dict(zip(keys, combo)))
        for result in (
            v.verify_fields(None, title="Invented paper about lunar llamas", authors="Nobody, A.", year=2024),
            v.verify_fields(None, title="Invented paper about lunar llamas", doi="10.9999/lunar.llamas"),
            v.verify_text(None, "Nobody, A. (2024). Invented paper about lunar llamas. Fake Journal, 1, 1–2."),
        ):
            assert result.label in (NOT_FOUND, NOT_YET_VERIFIED), (combo, result.reason)


# ------------------------------------------------------------------ retractions
def test_retraction_detected_from_retraction_watch(monkeypatch):
    Fake(monkeypatch, updates=WAKEFIELD_UPDATES)
    r = v.retraction_status(None, "10.1016/s0140-6736(97)11096-0")
    assert r["status"] == "retracted" and "2010-02-06" in r["detail"]


def test_no_notice_is_none_found_not_safe(monkeypatch):
    Fake(monkeypatch, updates=[])
    assert v.retraction_status(None, LECUN_DOI)["status"] == "none_found"


def test_retraction_check_unavailable_is_unknown(monkeypatch):
    Fake(monkeypatch, updates=p.UNAVAILABLE)
    assert v.retraction_status(None, LECUN_DOI)["status"] == "unknown"


# ------------------------------------------------------------------ formatting input
def test_crossref_to_csl_for_apa():
    csl = record_from_crossref(LECUN).csl
    assert csl["type"] == "article-journal"
    assert csl["title"] == "Deep learning"
    assert csl["container-title"] == "Nature"
    assert csl["volume"] == "521" and csl["issue"] == "7553" and csl["page"] == "436-444"
    assert csl["issued"] == {"date-parts": [[2015, 5, 27]]}
    assert csl["author"][0] == {"family": "LeCun", "given": "Yann"}
    assert csl["DOI"] == LECUN_DOI


# ------------------------------------------------------------------ partial outages
def test_partial_outage_is_never_not_found(monkeypatch):
    """Crossref rate-limited and OpenAlex has no match: a real paper must not be called
    Not found ("may not exist"). It is Not yet verified until every source answers."""
    Fake(monkeypatch, search=p.UNAVAILABLE, oa_search=[])
    for result in (
        v.verify_fields(None, title="Deep learning", authors="LeCun, Y.", year=2015),
        v.verify_text(None, "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444."),
    ):
        assert result.label == NOT_YET_VERIFIED, result.reason
        assert "Not every database could be checked" in result.reason and "Crossref" in result.reason


def test_partial_outage_with_a_near_miss_is_not_yet_verified(monkeypatch):
    Fake(monkeypatch, search=[LECUN], oa_search=p.UNAVAILABLE)
    result = v.verify_fields(None, title="Deep learning", authors="Fabricated, Zed", year=2015)
    assert result.label == NOT_YET_VERIFIED and "Closest record" in result.reason


def test_all_sources_answered_and_no_match_is_not_found(monkeypatch):
    Fake(monkeypatch, search=[UNRELATED], oa_search=[])
    assert v.verify_fields(None, title="Invented paper about lunar llamas", authors="Nobody, A.", year=2024).label == NOT_FOUND


def test_unregistered_doi_is_not_found_even_if_crossref_is_down(monkeypatch):
    Fake(monkeypatch, work=p.UNAVAILABLE, handle=p.NOT_FOUND, oa_doi=p.UNAVAILABLE)
    assert v.verify_fields(None, title="x", doi="10.9999/made.up").label == NOT_FOUND  # doi.org is definitive
