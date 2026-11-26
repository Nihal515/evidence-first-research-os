"""Free legal copies and abstracts from OpenAlex: found / none / unavailable, the
version is stated honestly, and an outage never erases a copy found earlier."""
import importlib

import pytest
from fastapi.testclient import TestClient

from backend import openaccess
from backend import providers as p
from tests.test_verify import LECUN, LECUN_DOI, Fake

HAL = {  # shape of the real OpenAlex record for 10.1038/nature14539 (trimmed)
    "open_access": {"is_oa": True, "oa_status": "green", "oa_url": "https://hal.science/hal-04206682"},
    "best_oa_location": {"is_oa": True, "landing_page_url": "https://hal.science/hal-04206682", "pdf_url": None,
                         "version": "submittedVersion", "license": "other-oa",
                         "source": {"display_name": "HAL", "type": "repository"}},
    "abstract_inverted_index": {"Deep": [0], "learning": [1], "allows": [2], "models": [3]},
}


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'oa.db'}")
    from backend import db
    importlib.reload(db)
    from backend import app as app_module
    importlib.reload(app_module)
    return TestClient(app_module.app)


def test_abstract_is_rebuilt_in_order():
    assert openaccess.abstract_from_inverted_index({"world": [1], "Hello": [0], "again": [3], "hello": [2]}) == "Hello world hello again"
    assert openaccess.abstract_from_inverted_index(None) is None
    assert openaccess.abstract_from_inverted_index({}) is None


def test_free_copy_states(monkeypatch):
    Fake(monkeypatch, open_access=HAL)
    info, abstract = openaccess.find_free_copy(None, LECUN_DOI)
    assert info["status"] == "found" and info["url"] == "https://hal.science/hal-04206682"
    assert info["is_pdf"] is False and info["version_text"] == "preprint (submitted version)" and info["host"] == "HAL"
    assert abstract == "Deep learning allows models"

    pdf = {**HAL, "best_oa_location": {**HAL["best_oa_location"], "pdf_url": "https://x.org/a.pdf", "version": "publishedVersion"}}
    Fake(monkeypatch, open_access=pdf)
    info, _ = openaccess.find_free_copy(None, LECUN_DOI)
    assert info["is_pdf"] and info["url"] == "https://x.org/a.pdf" and info["version_text"] == "published version"


def test_publisher_hosted_copy_links_the_article_page(monkeypatch):
    """Publisher direct-PDF links often need the publisher's session; the article page always opens."""
    wiley = {**HAL, "best_oa_location": {"is_oa": True, "landing_page_url": "https://doi.org/10.1002/sd.3221",
                                         "pdf_url": "https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/sd.3221",
                                         "version": "publishedVersion",
                                         "source": {"display_name": "Sustainable Development", "type": "journal"}}}
    Fake(monkeypatch, open_access=wiley)
    info, _ = openaccess.find_free_copy(None, "10.1002/sd.3221")
    assert info["url"] == "https://doi.org/10.1002/sd.3221" and info["is_pdf"] is False
    assert info["host"] == "Sustainable Development" and info["version_text"] == "published version"


def test_approval_records_the_free_copy(api, monkeypatch):
    Fake(monkeypatch, work=LECUN, updates=[], open_access=HAL)
    pid = api.post("/api/projects", json={"title": "t"}).json()["id"]
    ref = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI}).json()
    assert ref["label"] == "verified"
    assert ref["oa_pdf_url"] == "https://hal.science/hal-04206682" and ref["free_copy"]["host"] == "HAL"
    assert ref["abstract"] == "Deep learning allows models"


def test_outage_never_erases_a_copy_found_earlier(api, monkeypatch):
    Fake(monkeypatch, work=LECUN, updates=[], open_access=HAL)
    pid = api.post("/api/projects", json={"title": "t"}).json()["id"]
    rid = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI}).json()["id"]
    Fake(monkeypatch, work=LECUN, updates=[], open_access=p.UNAVAILABLE)
    ref = api.post(f"/api/projects/{pid}/references/{rid}/free-copy").json()
    assert ref["free_copy"]["status"] == "unavailable" and ref["oa_pdf_url"] == "https://hal.science/hal-04206682"


def test_free_copy_only_for_verified_references(api, monkeypatch):
    Fake(monkeypatch, work=p.UNAVAILABLE, handle=p.UNAVAILABLE, oa_doi=p.UNAVAILABLE, updates=[])
    pid = api.post("/api/projects", json={"title": "t"}).json()["id"]
    ref = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI}).json()
    assert ref["label"] == "not_yet_verified" and ref["free_copy"] is None
    assert api.post(f"/api/projects/{pid}/references/{ref['id']}/free-copy").status_code == 409
