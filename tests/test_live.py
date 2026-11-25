"""Live tests against the real Crossref, doi.org and OpenAlex APIs.

Run with:  RUN_LIVE=1 python -m pytest tests/test_live.py -v
Skipped by default so the offline test suite never depends on the network.
"""
import os
import time

import pytest

from backend import providers as p
from backend import verify as v
from backend.labels import NOT_FOUND, VERIFIED

pytestmark = pytest.mark.skipif(not os.getenv("RUN_LIVE"), reason="set RUN_LIVE=1 to call the real APIs")


@pytest.fixture()
def client():
    time.sleep(1.2)  # stay inside Crossref's public rate limit
    with p.make_client() as c:
        yield c


def test_live_real_doi_with_matching_details(client):
    r = v.verify_fields(client, title="Deep learning", authors="LeCun, Y., Bengio, Y., & Hinton, G.", year=2015,
                        doi="10.1038/nature14539")
    assert r.label == VERIFIED, r.reason


def test_live_fake_doi(client):
    r = v.verify_fields(client, title="Neural lunar llamas", authors="Nobody, A.", year=2024,
                        doi="10.1234/this-doi-does-not-exist-2026")
    assert r.label == NOT_FOUND, r.reason


def test_live_real_doi_with_made_up_title(client):
    r = v.verify_fields(client, title="Quantum banana cognition in Martian classrooms", doi="10.1038/nature14539")
    assert r.label == NOT_FOUND, r.reason


def test_live_made_up_title_and_author(client):
    r = v.verify_fields(client, title="Quantum banana cognition in Martian classrooms",
                        authors="Zxqvort, T.", year=2024)
    assert r.label == NOT_FOUND, r.reason


def test_live_real_reference_without_doi(client):
    r = v.verify_fields(client, title="Deep learning", authors="LeCun, Bengio, Hinton", year=2015)
    assert r.label == VERIFIED, r.reason
    assert r.record.doi == "10.1038/nature14539"


def test_live_real_title_with_made_up_author(client):
    r = v.verify_fields(client, title="Deep learning", authors="Fakeman, J.", year=2015)
    assert r.label == NOT_FOUND, r.reason


def test_live_pasted_apa_citation(client):
    r = v.verify_text(client, "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444.")
    assert r.label == VERIFIED, r.reason


def test_live_pasted_made_up_citation(client):
    r = v.verify_text(client, "Zxqvort, T. (2024). Quantum banana cognition in Martian classrooms. "
                              "Journal of Imaginary Studies, 3(2), 1–9.")
    assert r.label == NOT_FOUND, r.reason


def test_live_retraction_detected(client):
    r = v.retraction_status(client, "10.1016/s0140-6736(97)11096-0")
    assert r["status"] == "retracted", r


def test_live_search_finds_real_paper(client):
    res = v.search(client, "Deep learning LeCun Bengio Hinton 2015")
    assert res["status"] == "ok"
    assert any(r.doi == "10.1038/nature14539" for r in res["records"])
