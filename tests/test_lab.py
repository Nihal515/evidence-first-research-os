"""Integrity Lab: fixed corpus, scoring rules, and the public check used by the landing page."""
import importlib

import pytest
from fastapi.testclient import TestClient

from backend import lab
from backend import providers as p
from backend.labels import NOT_FOUND, NOT_YET_VERIFIED, VERIFIED
from tests.test_verify import LECUN, LECUN_DOI, WAKEFIELD_UPDATES, Fake


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'lab.db'}")
    from backend import db
    importlib.reload(db)
    from backend import app as app_module
    importlib.reload(app_module)
    return TestClient(app_module.app)


def test_corpus_matches_the_paper_trail_design():
    fam = {f: sum(1 for c in lab.CORPUS if c["family"] == f) for f in lab.FAMILIES}
    assert fam == {"real": 12, "total-fabrication": 2, "part-corrupted": 4, "hijacked-identifier": 2, "placeholder": 2,
                   "plausible-missing-title": 2}
    assert sum(1 for c in lab.CORPUS if c["expected"] == "retraction-flag") == 1
    assert all(c["invented"] == (c["family"] != "real") for c in lab.CORPUS)
    assert len({c["id"] for c in lab.CORPUS}) == 24


def case(cid_prefix):
    return next(c for c in lab.CORPUS if c["id"].startswith(cid_prefix))


@pytest.mark.parametrize("prefix,label,kw,outcome", [
    ("real:10.1016", VERIFIED, {}, "correct"),
    ("real:10.1016", NOT_FOUND, {}, "false-alarm"),
    ("real:10.1016", NOT_YET_VERIFIED, {}, "could-not-check"),
    ("real:10.1108", VERIFIED, {"retraction": "retracted"}, "expected-retraction"),
    ("real:10.1108", VERIFIED, {"retraction": "none_found"}, "missed"),
    ("real:10.1108", VERIFIED, {"retraction": "unknown"}, "could-not-check"),
    ("invented:total", NOT_FOUND, {}, "caught"),
    ("invented:total", VERIFIED, {}, "missed"),
    ("invented:total", VERIFIED, {"unavailable": True}, "missed"),       # a miss stays a miss
    ("invented:author", NOT_YET_VERIFIED, {}, "could-not-check"),      # never a success
    ("invented:placeholder", None, {"refused": True}, "caught"),
])
def test_scoring_rules(prefix, label, kw, outcome):
    assert lab.evaluate(case(prefix), label, **kw)["outcome"] == outcome


def test_limited_coverage_is_flagged_separately():
    ev = lab.evaluate(case("invented:total"), NOT_FOUND, unavailable=True)
    assert ev["outcome"] == "caught" and ev["limited_coverage"] is True


def test_lab_endpoints(api, monkeypatch):
    body = api.get("/api/lab").json()
    assert len(body["cases"]) == 24 and body["manifest"]["limits"]
    Fake(monkeypatch, search=[], oa_search=[])
    r = api.post("/api/lab/run", params={"case_id": "invented:total:1"}).json()
    assert r["label"] == NOT_FOUND and r["evaluation"]["outcome"] == "caught"
    r = api.post("/api/lab/run", params={"case_id": "invented:placeholder:1"}).json()  # "[ citation needed ]"
    assert r["refused"] and r["evaluation"]["outcome"] == "caught"
    r = api.post("/api/lab/run", params={"case_id": "invented:placeholder:2"}).json()  # "TODO" is refused as input
    assert r["refused"] and r["evaluation"]["outcome"] == "caught"
    assert api.post("/api/lab/run", params={"case_id": "nope:1"}).status_code == 404


def test_public_check_saves_nothing_and_checks_retraction(api, monkeypatch):
    Fake(monkeypatch, work=LECUN, updates=WAKEFIELD_UPDATES)
    r = api.post("/api/check", json={"mode": "doi", "doi": LECUN_DOI}).json()
    assert r["label"] == VERIFIED and r["retraction"]["status"] == "none_found"  # the notice is for another DOI
    Fake(monkeypatch, work=None, handle=p.NOT_FOUND)
    r = api.post("/api/check", json={"mode": "doi", "doi": "10.9999/made.up"}).json()
    assert r["label"] == NOT_FOUND and r["retraction"] is None
