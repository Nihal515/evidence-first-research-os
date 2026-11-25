"""API tests: one-click approval, fake references never added, export events,
AI-use summary built only from recorded events. Uses SQLite and recorded
provider responses."""
import importlib

import pytest
from fastapi.testclient import TestClient

from backend import providers as p
from tests.test_verify import LECUN, LECUN_DOI, UNRELATED, WAKEFIELD_UPDATES, Fake


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    from backend import db
    importlib.reload(db)
    from backend import app as app_module
    importlib.reload(app_module)
    return TestClient(app_module.app)


def make_project(api):
    r = api.post("/api/projects", json={"title": "AI in education", "question": "Does AI tutoring improve outcomes?"})
    assert r.status_code == 201
    return r.json()["id"]


def test_health_reports_database(api):
    body = api.get("/api/health").json()
    assert body["status"] == "ok" and body["database"] == "connected"


def test_labels_are_the_four_trust_labels(api):
    assert set(api.get("/api/labels").json()) == {"verified", "not_yet_verified", "ai_suggestion", "not_found"}


def test_fake_reference_is_not_found_and_cannot_be_added(api, monkeypatch):
    Fake(monkeypatch, work=None, handle=p.NOT_FOUND, search=[UNRELATED], oa_search=[])
    pid = make_project(api)
    fake = {"mode": "fields", "title": "Quantum banana cognition", "authors": "Zxqvort, T.", "year": 2024,
            "doi": "10.1234/fake-2026"}
    check = api.post(f"/api/projects/{pid}/check", json=fake).json()
    assert check["label"] == "not_found"
    add = api.post(f"/api/projects/{pid}/references", json=fake)
    assert add.status_code == 422
    assert api.get(f"/api/projects/{pid}/references").json() == []


def test_search_adds_nothing_until_approved(api, monkeypatch):
    Fake(monkeypatch, search=[LECUN])
    pid = make_project(api)
    res = api.get(f"/api/projects/{pid}/search", params={"q": "deep learning"}).json()
    assert res["status"] == "ok" and res["results"][0]["label"] == "verified"
    assert api.get(f"/api/projects/{pid}/references").json() == []


def test_one_click_approval_adds_verified_reference_with_retraction_status(api, monkeypatch):
    Fake(monkeypatch, work=LECUN, updates=[])
    pid = make_project(api)
    r = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI})
    assert r.status_code == 201
    ref = r.json()
    assert ref["label"] == "verified" and ref["doi"] == LECUN_DOI
    assert ref["csl"]["container-title"] == "Nature"
    assert ref["retraction"]["status"] == "none_found"
    again = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI})
    assert again.status_code == 409


def test_retracted_paper_is_flagged(api, monkeypatch):
    wakefield = {"DOI": "10.1016/s0140-6736(97)11096-0", "title": ["Ileal-lymphoid-nodular hyperplasia"],
                 "author": [{"given": "AJ", "family": "Wakefield"}], "issued": {"date-parts": [[1998]]},
                 "type": "journal-article", "container-title": ["The Lancet"]}
    Fake(monkeypatch, work=wakefield, updates=WAKEFIELD_UPDATES)
    pid = make_project(api)
    ref = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": wakefield["DOI"]}).json()
    assert ref["retraction"]["status"] == "retracted"


def test_unavailable_check_is_added_only_as_not_yet_verified(api, monkeypatch):
    Fake(monkeypatch, search=p.UNAVAILABLE, oa_search=p.UNAVAILABLE)
    pid = make_project(api)
    body = {"mode": "fields", "title": "Deep learning", "authors": "LeCun", "year": 2015}
    assert api.post(f"/api/projects/{pid}/check", json=body).json()["label"] == "not_yet_verified"
    ref = api.post(f"/api/projects/{pid}/references", json=body).json()
    assert ref["label"] == "not_yet_verified" and ref["csl"] is None
    # Once the databases answer again, re-checking upgrades it to Verified.
    Fake(monkeypatch, search=[LECUN], updates=[])
    rechecked = api.post(f"/api/projects/{pid}/references/{ref['id']}/recheck").json()
    assert rechecked["label"] == "verified" and rechecked["doi"] == LECUN_DOI


def test_remove_and_audit_log(api, monkeypatch):
    Fake(monkeypatch, work=LECUN, updates=[])
    pid = make_project(api)
    ref = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI}).json()
    assert api.delete(f"/api/projects/{pid}/references/{ref['id']}").status_code == 200
    events = [e["event"] for e in api.get(f"/api/projects/{pid}/audit").json()]
    assert events == ["PROJECT_CREATED", "REFERENCE_APPROVED", "REFERENCE_REMOVED"]


def test_client_events_are_whitelisted(api):
    pid = make_project(api)
    assert api.post(f"/api/projects/{pid}/events", json={"event": "EXPORT_APA_COPIED", "detail": {"count": 2}}).status_code == 201
    assert api.post(f"/api/projects/{pid}/events", json={"event": "AI_RUN", "detail": {}}).status_code == 400


def test_summary_counts_only_recorded_events(api, monkeypatch):
    Fake(monkeypatch, work=LECUN, handle=p.NOT_FOUND, search=[LECUN], oa_search=[], updates=[])
    pid = make_project(api)
    api.get(f"/api/projects/{pid}/search", params={"q": "deep learning"})
    api.post(f"/api/projects/{pid}/check", json={"mode": "fields", "title": "Fake", "doi": "10.1234/nope"})
    api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI})
    api.post(f"/api/projects/{pid}/events", json={"event": "EXPORT_APA_DOWNLOADED", "detail": {"count": 1}})
    s = api.get(f"/api/projects/{pid}/summary").json()
    assert s["searches"] == 1
    assert s["checks"] == {"total": 1, "verified": 0, "not_found": 1, "not_yet_verified": 0}
    assert s["references"]["total"] == 1 and s["references"]["verified"] == 1
    assert s["approvals"] == 1 and s["exports"] == 1 and s["ai_runs"] == 0
    assert "Crossref" in s["sources_checked"]


def test_bad_ids_and_inputs_are_rejected(api):
    assert api.get("/api/projects/not-an-id").status_code == 422
    assert api.get("/api/projects/" + "0" * 32).status_code == 404
    pid = make_project(api)
    assert api.post(f"/api/projects/{pid}/check", json={"mode": "fields", "authors": "Only authors"}).status_code == 400
    assert api.post(f"/api/projects/{pid}/check", json={"mode": "fields", "title": "x", "year": 3000}).status_code == 422


def test_approval_rechecks_once_after_a_brief_outage(api, monkeypatch):
    """The user saw Verified; at approval Crossref is briefly rate-limited. The server
    checks once more and adds it as Verified, instead of calling it Not found."""
    Fake(monkeypatch, work=LECUN, updates=[], oa_search=[])
    calls = {"n": 0}

    def flaky_search(c, q, rows=10):
        calls["n"] += 1
        if calls["n"] == 1:
            return p.ProviderResult(p.UNAVAILABLE, "Crossref", detail="rate limited")
        return p.ProviderResult(p.OK, "Crossref", [LECUN])

    monkeypatch.setattr(p, "crossref_search", flaky_search)
    import backend.app as app_module
    monkeypatch.setattr(app_module.time, "sleep", lambda s: None)
    pid = make_project(api)
    text = "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444."
    r = api.post(f"/api/projects/{pid}/references", json={"mode": "text", "text": text})
    assert r.status_code == 201 and r.json()["label"] == "verified" and calls["n"] == 2


def test_approval_during_a_lasting_outage_is_not_yet_verified_never_not_found(api, monkeypatch):
    Fake(monkeypatch, work=LECUN, updates=[], search=p.UNAVAILABLE, oa_search=[])
    import backend.app as app_module
    monkeypatch.setattr(app_module.time, "sleep", lambda s: None)
    pid = make_project(api)
    text = "LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444."
    r = api.post(f"/api/projects/{pid}/references", json={"mode": "text", "text": text})
    assert r.status_code == 201 and r.json()["label"] == "not_yet_verified"
