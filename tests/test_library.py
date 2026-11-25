"""Library stage: safe migration, favourites, read state, notes, Trash, bulk actions,
collections, duplicate detection and merge. Trust labels can only change through
a live re-check, never through library actions."""
import importlib

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from backend import library
from tests.test_verify import LECUN, LECUN_DOI, Fake


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'lib.db'}")
    from backend import db
    importlib.reload(db)
    from backend import app as app_module
    importlib.reload(app_module)
    return TestClient(app_module.app), db


def seed(db, pid, title, *, label="verified", doi=None, authors=("Yann LeCun",), year=2015):
    return db.add_reference(db.get_engine(), pid, {
        "label": label, "reason": "test", "doi": doi, "title": title, "authors": list(authors), "year": year,
        "container": "Test Journal", "provider": "Crossref" if label == "verified" else "",
        "csl": None, "checks": [], "retraction": {}, "user_input": {}, "checked_at": "2026-11-25T10:00:00Z"})


def project(api):
    return api.post("/api/projects", json={"title": "Library test", "question": ""}).json()["id"]


# ------------------------------------------------------------------ migration
def test_migration_adds_columns_to_an_existing_database_without_losing_rows(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'old.db'}"
    old = create_engine(url)
    with old.begin() as conn:  # the stage 1a schema, with one existing row
        conn.execute(text("CREATE TABLE projects (id VARCHAR(32) PRIMARY KEY, title VARCHAR(300) NOT NULL, "
                          "question TEXT NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL)"))
        conn.execute(text("CREATE TABLE project_references (id VARCHAR(32) PRIMARY KEY, project_id VARCHAR(32) NOT NULL, "
                          "label VARCHAR(32) NOT NULL, reason TEXT NOT NULL, doi VARCHAR(300), title TEXT NOT NULL, "
                          "authors TEXT NOT NULL, year INTEGER, container TEXT NOT NULL, provider VARCHAR(40) NOT NULL, "
                          "csl TEXT, checks TEXT NOT NULL, retraction TEXT NOT NULL, user_input TEXT NOT NULL, "
                          "checked_at VARCHAR(40) NOT NULL, approved_at DATETIME NOT NULL, "
                          "CONSTRAINT uq_project_doi UNIQUE (project_id, doi))"))
        conn.execute(text("INSERT INTO projects VALUES ('a'||hex(randomblob(15)), 'Old', '', '2026-11-25', '2026-11-25')"))
        pid = conn.execute(text("SELECT id FROM projects")).scalar()
        conn.execute(text("INSERT INTO project_references VALUES ('b'||hex(randomblob(15)), :pid, 'verified', 'r', "
                          "'10.1/x', 'Kept title', '[]', 2015, 'J', 'Crossref', NULL, '[]', '{}', '{}', "
                          "'2026-11-25T10:00:00Z', '2026-11-25 10:00:00')"), {"pid": pid})
    old.dispose()
    monkeypatch.setenv("DATABASE_URL", url)
    from backend import db
    importlib.reload(db)
    refs = db.list_references(db.get_engine(), pid)
    assert len(refs) == 1 and refs[0]["title"] == "Kept title"
    assert refs[0]["favorite"] is False and refs[0]["deleted_at"] is None and refs[0]["collection_ids"] == []
    db.get_engine()  # running the migration again is harmless


# ------------------------------------------------------------------ favourites, read, notes
def test_favourite_read_and_notes(env):
    api, db = env
    pid = project(api)
    rid = seed(db, pid, "Deep learning")["id"]
    r = api.patch(f"/api/projects/{pid}/references/{rid}", json={"favorite": True, "read": True, "notes": "Key paper"})
    body = r.json()
    assert r.status_code == 200 and body["favorite"] is True and body["read_at"] and body["notes"] == "Key paper"
    body = api.patch(f"/api/projects/{pid}/references/{rid}", json={"read": False}).json()
    assert body["read_at"] is None and body["favorite"] is True


def test_library_actions_cannot_change_a_trust_label(env):
    api, db = env
    pid = project(api)
    rid = seed(db, pid, "Unchecked reference", label="not_yet_verified")["id"]
    body = api.patch(f"/api/projects/{pid}/references/{rid}",
                     json={"favorite": True, "label": "verified", "doi": "10.1/fake"}).json()
    assert body["label"] == "not_yet_verified" and body["doi"] is None


# ------------------------------------------------------------------ Trash
def test_trash_restore_and_delete_forever(env, monkeypatch):
    api, db = env
    Fake(monkeypatch, work=LECUN, updates=[])
    pid = project(api)
    rid = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI}).json()["id"]
    assert api.delete(f"/api/projects/{pid}/references/{rid}?permanent=true").status_code == 409  # not in Trash yet
    assert api.delete(f"/api/projects/{pid}/references/{rid}").status_code == 200
    assert api.get(f"/api/projects/{pid}/references").json() == []
    trashed = api.get(f"/api/projects/{pid}/references?include_trash=true").json()
    assert len(trashed) == 1 and trashed[0]["deleted_at"]
    again = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI})
    assert again.status_code == 409 and "Trash" in again.json()["detail"]
    api.patch(f"/api/projects/{pid}/references/{rid}", json={"trashed": False})
    assert len(api.get(f"/api/projects/{pid}/references").json()) == 1
    api.delete(f"/api/projects/{pid}/references/{rid}")
    assert api.delete(f"/api/projects/{pid}/references/{rid}?permanent=true").status_code == 200
    assert api.get(f"/api/projects/{pid}/references?include_trash=true").json() == []
    events = [e["event"] for e in api.get(f"/api/projects/{pid}/audit").json()]
    assert events[-4:] == ["REFERENCE_REMOVED", "REFERENCE_RESTORED", "REFERENCE_REMOVED", "REFERENCE_DELETED"]


def test_summary_ignores_trashed_references(env):
    api, db = env
    pid = project(api)
    keep, gone = seed(db, pid, "A")["id"], seed(db, pid, "B", doi="10.1/b")["id"]
    api.delete(f"/api/projects/{pid}/references/{gone}")
    assert api.get(f"/api/projects/{pid}/summary").json()["references"]["total"] == 1
    assert keep


# ------------------------------------------------------------------ bulk actions
def test_bulk_actions(env):
    api, db = env
    pid = project(api)
    ids = [seed(db, pid, f"Paper {i}", doi=f"10.1/{i}")["id"] for i in range(3)]
    r = api.post(f"/api/projects/{pid}/references/bulk", json={"ids": ids[:2], "action": "favorite"})
    assert r.json()["count"] == 2
    refs = {x["id"]: x for x in api.get(f"/api/projects/{pid}/references").json()}
    assert refs[ids[0]]["favorite"] and refs[ids[1]]["favorite"] and not refs[ids[2]]["favorite"]
    assert api.post(f"/api/projects/{pid}/references/bulk",
                    json={"ids": ids, "action": "delete_forever"}).status_code == 409  # not in Trash
    api.post(f"/api/projects/{pid}/references/bulk", json={"ids": ids, "action": "trash"})
    assert api.get(f"/api/projects/{pid}/references").json() == []
    api.post(f"/api/projects/{pid}/references/bulk", json={"ids": ids[:1], "action": "restore"})
    assert [x["id"] for x in api.get(f"/api/projects/{pid}/references").json()] == ids[:1]
    assert api.post(f"/api/projects/{pid}/references/bulk",
                    json={"ids": ["zz"], "action": "favorite"}).status_code == 422


def test_bulk_ignores_references_from_another_project(env):
    api, db = env
    mine, theirs = project(api), project(api)
    other = seed(db, theirs, "Not yours")["id"]
    assert api.post(f"/api/projects/{mine}/references/bulk",
                    json={"ids": [other], "action": "trash"}).status_code == 404
    assert len(api.get(f"/api/projects/{theirs}/references").json()) == 1


# ------------------------------------------------------------------ collections
def test_collections_nested_rename_move_and_delete(env):
    api, db = env
    pid = project(api)
    top = api.post(f"/api/projects/{pid}/collections", json={"name": "Dissertation"}).json()
    sub = api.post(f"/api/projects/{pid}/collections", json={"name": "Chapter 2", "parent_id": top["id"]}).json()
    assert sub["parent_id"] == top["id"]
    assert api.post(f"/api/projects/{pid}/collections", json={"name": "dissertation"}).status_code == 409
    assert api.patch(f"/api/projects/{pid}/collections/{top['id']}",
                     json={"parent_id": sub["id"]}).status_code == 409  # no cycles
    assert api.patch(f"/api/projects/{pid}/collections/{sub['id']}", json={"name": "Methods"}).json()["name"] == "Methods"
    rid = seed(db, pid, "Deep learning")["id"]
    api.post(f"/api/projects/{pid}/references/bulk", json={"ids": [rid], "action": "add_to_collection",
                                                           "collection_id": sub["id"]})
    assert api.get(f"/api/projects/{pid}/references").json()[0]["collection_ids"] == [sub["id"]]
    deleted = api.delete(f"/api/projects/{pid}/collections/{top['id']}").json()["deleted"]
    assert set(deleted) == {top["id"], sub["id"]}
    refs = api.get(f"/api/projects/{pid}/references").json()
    assert len(refs) == 1 and refs[0]["collection_ids"] == []  # the reference itself is kept


def test_approving_into_a_collection(env, monkeypatch):
    api, db = env
    Fake(monkeypatch, work=LECUN, updates=[])
    pid = project(api)
    col = api.post(f"/api/projects/{pid}/collections", json={"name": "Neuro"}).json()
    ref = api.post(f"/api/projects/{pid}/references",
                   json={"mode": "doi", "doi": LECUN_DOI, "collection_id": col["id"]}).json()
    assert ref["label"] == "verified" and ref["collection_ids"] == [col["id"]]


# ------------------------------------------------------------------ duplicates
def test_duplicate_rule():
    a = {"id": "1", "title": "Attention is all you need", "year": 2017, "authors": ["Ashish Vaswani"]}
    b = {"id": "2", "title": "Attention Is All You Need.", "year": 2018, "authors": ["Vaswani, A."]}
    c = {"id": "3", "title": "Attention is all you need", "year": 2017, "authors": ["Someone Else"]}
    d = {"id": "4", "title": "Attention is all you need", "year": 2009, "authors": ["Ashish Vaswani"]}
    assert library.is_possible_duplicate(a, b)
    assert not library.is_possible_duplicate(a, c)  # different authors
    assert not library.is_possible_duplicate(a, d)  # years far apart
    groups = library.duplicate_groups([a, c, b])
    assert [[r["id"] for r in g] for g in groups] == [["1", "2"]]


def test_find_and_merge_duplicates(env):
    api, db = env
    pid = project(api)
    col = api.post(f"/api/projects/{pid}/collections", json={"name": "Reading"}).json()
    verified = seed(db, pid, "Attention is all you need", doi="10.1/published", authors=["Ashish Vaswani"], year=2017)
    copy = seed(db, pid, "Attention Is All You Need", label="not_yet_verified", authors=["Vaswani, A."], year=2017)
    seed(db, pid, "Something different", doi="10.1/other")
    api.post(f"/api/projects/{pid}/references/bulk", json={"ids": [copy["id"]], "action": "add_to_collection",
                                                           "collection_id": col["id"]})
    api.patch(f"/api/projects/{pid}/references/{copy['id']}", json={"favorite": True, "notes": "my notes"})
    groups = api.get(f"/api/projects/{pid}/duplicates").json()["groups"]
    assert groups == [[verified["id"], copy["id"]]]  # the Verified record is suggested to keep
    kept = api.post(f"/api/projects/{pid}/duplicates/merge",
                    json={"keep_id": verified["id"], "remove_ids": [copy["id"]]}).json()
    assert kept["favorite"] and col["id"] in kept["collection_ids"] and "my notes" in kept["notes"]
    assert kept["label"] == "verified"
    active = [r["id"] for r in api.get(f"/api/projects/{pid}/references").json()]
    assert copy["id"] not in active  # moved to Trash, so the merge can be undone
    assert api.get(f"/api/projects/{pid}/duplicates").json()["groups"] == []


def test_new_export_events_are_counted(env):
    api, db = env
    pid = project(api)
    for ev in ("EXPORT_BIBTEX_DOWNLOADED", "EXPORT_RIS_DOWNLOADED"):
        assert api.post(f"/api/projects/{pid}/events", json={"event": ev, "detail": {"count": 1}}).status_code == 201
    assert api.get(f"/api/projects/{pid}/summary").json()["exports"] == 2


def test_whole_library_in_one_request(env):
    api, db = env
    pid = project(api)
    col = api.post(f"/api/projects/{pid}/collections", json={"name": "Neuro"}).json()
    keep = seed(db, pid, "Attention is all you need", doi="10.1/a", authors=["Ashish Vaswani"], year=2017)
    seed(db, pid, "Attention Is All You Need", label="not_yet_verified", authors=["Vaswani, A."], year=2017)
    gone = seed(db, pid, "Binned", doi="10.1/b")
    api.delete(f"/api/projects/{pid}/references/{gone['id']}")
    body = api.get(f"/api/projects/{pid}/library").json()
    assert len(body["references"]) == 3 and any(r["deleted_at"] for r in body["references"])
    assert body["collections"] == [col]
    assert body["duplicates"]["groups"][0][0] == keep["id"] and body["duplicates"]["rule"]


def test_schema_check_is_skipped_when_current(env, monkeypatch):
    api, db = env
    engine = db.get_engine()
    calls = []
    monkeypatch.setattr(db, "_add_missing_columns", lambda conn: calls.append(1))
    db._ensure_schema(engine)  # schema already current: no migration work
    assert calls == []
