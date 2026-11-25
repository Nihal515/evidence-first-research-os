"""FastAPI application: projects, live search, live reference checks,
one-click approval, reference list, audit log and AI-use summary."""
from __future__ import annotations

import json
import os
import re
import time
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Path, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import auth
from . import db
from . import keycheck
from . import lab
from . import library
from . import openaccess
from . import providers
from .labels import LABELS, NOT_FOUND, NOT_YET_VERIFIED, VERIFIED
from .records import normalize_doi, record_from_crossref
from .verify import now_iso, retraction_status, search, verify_fields, verify_text

app = FastAPI(title="Evidence-First Research OS API", version="1.0.0-stage1")

ID = r"^[0-9a-f]{32}$"
CLIENT_EVENTS = {"EXPORT_APA_COPIED", "EXPORT_APA_DOWNLOADED", "EXPORT_BIBTEX_DOWNLOADED", "EXPORT_RIS_DOWNLOADED",
                 "STATEMENT_COPIED", "STATEMENT_DOWNLOADED"}


app.middleware("http")(auth.identity_middleware)


def public_project(project: dict) -> dict:
    """Never send an owner id to the browser; say only whether it is yours."""
    user = auth.current_user.get()
    out = {k: v for k, v in project.items() if k != "owner_id"}
    out["owned"] = bool(project.get("owner_id"))
    out["owned_by_you"] = bool(user and project.get("owner_id") == user["id"])
    return out


@app.exception_handler(Exception)
async def unhandled(_request, exc):  # never leak stack traces or secrets
    return JSONResponse(status_code=500, content={"detail": "Something went wrong on the server. Please try again."})


def require_db():
    try:
        engine = db.get_engine()
    except Exception:
        raise HTTPException(503, "The database could not be reached. Please try again in a moment.")
    if engine is None:
        raise HTTPException(503, "The database is not connected yet.")
    return engine


def require_project(engine, pid: str) -> dict:
    """A guest project (no owner) is reachable by its id, as before. A project that
    belongs to an account is reachable only by that signed-in account; anyone else
    gets "not found", so its existence is not revealed."""
    project = db.get_project(engine, pid)
    if not project:
        raise HTTPException(404, "Project not found.")
    owner = project.get("owner_id")
    if owner:
        user = auth.current_user.get()
        if not user or user["id"] != owner:
            raise HTTPException(404, "Project not found.")
    return project


# ------------------------------------------------------------------ models
class ProjectIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    question: str = Field(default="", max_length=2000)


class CheckIn(BaseModel):
    mode: Literal["fields", "text", "doi"] = "fields"
    title: str = Field(default="", max_length=500)
    authors: str = Field(default="", max_length=1000)
    year: Optional[int] = Field(default=None, ge=1500, le=2100)
    doi: str = Field(default="", max_length=300)
    text: str = Field(default="", max_length=2000)
    collection_id: Optional[str] = Field(default=None, pattern=ID)  # file the approved source here


class EventIn(BaseModel):
    event: str
    detail: dict = Field(default_factory=dict)


def run_check(client, body: CheckIn):
    try:
        if body.mode == "text":
            return verify_text(client, body.text)
        if body.mode == "doi":
            return verify_fields(client, doi=body.doi)
        return verify_fields(client, title=body.title, authors=body.authors, year=body.year, doi=body.doi)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


def _input_summary(body: CheckIn) -> dict:
    if body.mode == "text":
        return {"mode": "text", "text": body.text[:200]}
    return {"mode": body.mode, "title": body.title[:200], "authors": body.authors[:200],
            "year": body.year, "doi": body.doi[:100]}


# ------------------------------------------------------------------ health and labels
@app.get("/api/health")
def health():
    try:
        engine = db.get_engine()
        database = "connected" if engine is not None else "not_configured"
    except Exception:
        database = "error"
    return {
        "status": "ok",
        "version": app.version,
        "database": database,
        "crossref_polite_pool": bool(os.getenv("CROSSREF_MAILTO")),
        "openalex_key": bool(os.getenv("OPENALEX_API_KEY")),
        "llm": "connected" if os.getenv("LLM_API_KEY") else "not_connected",
        "auth": "configured" if auth.configured() else "not_configured",
    }


@app.get("/api/health/keys")
def health_keys():
    """Tests each saved API key with its provider (cached for 60 s).
    Reports only valid / invalid / not_configured / unavailable — never a key."""
    return keycheck.check_all(providers.make_client)


# ------------------------------------------------------------------ accounts
@app.api_route("/api/auth/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
async def auth_proxy(path: str, request: Request):
    return await auth.proxy(request, path)


@app.get("/api/me")
def me():
    user = auth.current_user.get()
    return {"signed_in": bool(user), "user": user, "auth_configured": auth.configured()}


def require_user() -> dict:
    user = auth.current_user.get()
    if not user:
        raise HTTPException(401, "Please sign in first.")
    return user


@app.get("/api/me/projects")
def my_projects():
    user = require_user()
    engine = require_db()
    return [public_project(p) for p in db.list_owned_projects(engine, user["id"])]


@app.post("/api/projects/{pid}/claim")
def claim_project(pid: str = Path(pattern=ID)):
    """Save a guest project to the signed-in account. Only a project with no owner can be claimed."""
    user = require_user()
    engine = require_db()
    project = require_project(engine, pid)
    if project.get("owner_id") and project["owner_id"] != user["id"]:
        raise HTTPException(404, "Project not found.")
    db.set_project_owner(engine, pid, user["id"])
    db.log(engine, pid, "user", "PROJECT_SAVED_TO_ACCOUNT", {})
    return public_project(db.get_project(engine, pid))


@app.get("/api/labels")
def labels():
    return LABELS


# ------------------------------------------------------------------ projects
@app.post("/api/projects", status_code=201)
def create_project(body: ProjectIn):
    engine = require_db()
    user = auth.current_user.get()
    return public_project(db.create_project(engine, body.title.strip(), body.question.strip(),
                                            owner_id=user["id"] if user else None))


@app.get("/api/projects/{pid}")
def get_project(pid: str = Path(pattern=ID)):
    engine = require_db()
    return public_project(require_project(engine, pid))


@app.put("/api/projects/{pid}")
def edit_project(body: ProjectIn, pid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    return public_project(db.update_project(engine, pid, body.title.strip(), body.question.strip()))


# ------------------------------------------------------------------ search (nothing is saved)
@app.get("/api/projects/{pid}/search")
def run_search(pid: str = Path(pattern=ID), q: str = Query(min_length=2, max_length=300)):
    engine = require_db()
    require_project(engine, pid)
    with providers.make_client() as client:
        res = search(client, q.strip())
    in_list = {r["doi"] for r in db.list_references(engine, pid) if r["doi"]}
    results = []
    for rec in res["records"]:
        results.append({
            "label": VERIFIED,
            "reason": f"Record retrieved live from {res['provider']}.",
            "record": rec.summary(),
            "in_list": bool(rec.doi and rec.doi in in_list),
        })
    db.log(engine, pid, "system", "SEARCH_RUN",
           {"query": q[:200], "provider": res["provider"], "status": res["status"], "results": len(results)})
    return {"status": res["status"], "provider": res["provider"], "retrieved_at": res["retrieved_at"],
            "note": res.get("note", ""), "results": results}


# ------------------------------------------------------------------ public check (landing page; nothing is saved)
@app.post("/api/check")
def public_check(body: CheckIn):
    """Check one reference without a project — used by the landing page and the Check
    page. Nothing is stored or logged. A Verified result with a DOI also gets a live
    retraction check."""
    with providers.make_client() as client:
        result = run_check(client, body)
        out = result.to_dict()
        rec = result.record
        out["retraction"] = retraction_status(client, rec.doi) if result.label == VERIFIED and rec and rec.doi else None
    return out


# ------------------------------------------------------------------ Integrity Lab
@app.get("/api/lab")
def lab_corpus():
    return {"manifest": lab.MANIFEST, "families": [{"id": f, "label": lab.FAMILY_LABELS[f]} for f in lab.FAMILIES],
            "cases": lab.CORPUS}


@app.post("/api/lab/run")
def lab_run(case_id: str = Query(min_length=3, max_length=120)):
    """Run one fixed corpus case through the live checker and score it. The input comes
    from the corpus on the server, so a run cannot be altered from the browser."""
    case = lab.BY_ID.get(case_id)
    if not case:
        raise HTTPException(404, "Unknown case.")
    body = CheckIn(**lab.check_input(case))
    with providers.make_client() as client:
        try:
            result = run_check(client, body)
        except HTTPException as exc:
            if exc.status_code == 400:  # the input was refused as too thin to be a reference
                return {"case_id": case_id, "refused": True, "reason": str(exc.detail), "label": None,
                        "checked_at": now_iso(), "evaluation": lab.evaluate(case, None, refused=True)}
            raise
        out = result.to_dict()
        rec = result.record
        retraction = None
        if result.label == VERIFIED and rec and rec.doi and case["expected"] == "retraction-flag":
            retraction = retraction_status(client, rec.doi)
    out.update(case_id=case_id, refused=False, retraction=retraction,
               evaluation=lab.evaluate(case, result.label, unavailable=bool(result.unavailable),
                                       retraction=(retraction or {}).get("status")))
    return out


# ------------------------------------------------------------------ live reference check (nothing is saved)
@app.post("/api/projects/{pid}/check")
def check_reference(body: CheckIn, pid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    with providers.make_client() as client:
        result = run_check(client, body)
    out = result.to_dict()
    rec = result.record
    out["in_list"] = bool(rec and rec.doi and db.find_reference_by_doi(engine, pid, rec.doi))
    db.log(engine, pid, "system", "REFERENCE_CHECKED",
           {"input": _input_summary(body), "label": result.label, "sources": result.sources_checked,
            "unavailable": result.unavailable})
    return out


# ------------------------------------------------------------------ one-click approval
def _values_from_result(client, result, body: CheckIn) -> dict:
    """Turn a server-side verification result into stored reference values."""
    if result.label == VERIFIED:
        rec = result.record
        if rec.provider != "Crossref" and rec.doi:
            cr = providers.crossref_work(client, rec.doi)
            if cr.status == providers.OK:
                rec = record_from_crossref(cr.data)
        return {
            "label": VERIFIED,
            "reason": result.reason,
            "doi": rec.doi,
            "title": rec.title,
            "authors": rec.authors,
            "year": rec.year,
            "container": rec.container,
            "provider": rec.provider,
            "csl": rec.csl,
            "checks": [c.to_dict() for c in result.checks],
            "retraction": retraction_status(client, rec.doi),
            "user_input": _input_summary(body),
            "checked_at": result.checked_at,
        }
    # Not yet verified: keep exactly what the user entered, never a guessed record.
    title = body.title.strip() if body.mode == "fields" else body.text.strip()
    if body.mode == "doi":
        title = f"DOI {body.doi.strip()}"
    years = re.findall(r"\b(1[5-9]\d\d|20\d\d)\b", body.text) if body.mode == "text" else []
    return {
        "label": NOT_YET_VERIFIED,
        "reason": result.reason,
        "doi": normalize_doi(body.doi) if body.doi else None,
        "title": title[:500] or "Untitled reference",
        "authors": [body.authors.strip()] if body.authors.strip() else [],
        "year": body.year or (int(years[0]) if years else None),
        "container": "",
        "provider": "",
        "csl": None,
        "checks": [c.to_dict() for c in result.checks],
        "retraction": {"status": "unknown", "detail": "Not checked because the reference is not yet verified."},
        "user_input": _input_summary(body),
        "checked_at": result.checked_at,
    }


@app.post("/api/projects/{pid}/references", status_code=201)
def approve_reference(body: CheckIn, pid: str = Path(pattern=ID)):
    """Called only by the user's one-click Approve button. The server re-checks the
    reference live first: a reference that is Not found can never be added."""
    engine = require_db()
    require_project(engine, pid)
    with providers.make_client() as client:
        started = time.monotonic()
        result = run_check(client, body)
        if result.label == NOT_YET_VERIFIED and result.unavailable and time.monotonic() - started < 10:
            time.sleep(1.5)  # a database was briefly busy (e.g. rate limited): check once more
            result = run_check(client, body)
        if result.label == NOT_FOUND:
            raise HTTPException(422, {"message": "This reference could not be verified, so it was not added.",
                                      "result": result.to_dict()})
        values = _values_from_result(client, result, body)
        free = abstract = None
        if values["label"] == VERIFIED and values["doi"]:
            free, abstract = openaccess.find_free_copy(client, values["doi"])
    existing = db.find_reference_by_doi(engine, pid, values["doi"]) if values["doi"] else None
    if existing:
        if existing.get("deleted_at"):
            raise HTTPException(409, "This source is already in your library, in Trash. Restore it from Trash.")
        raise HTTPException(409, "This source is already in your reference list.")
    ref = db.add_reference(engine, pid, values)
    if free:
        _store_free_copy(engine, pid, ref["id"], free, abstract)
        ref = db.get_reference(engine, pid, ref["id"])
    if body.collection_id and db.get_collection(engine, pid, body.collection_id):
        db.add_to_collection(engine, pid, body.collection_id, [ref["id"]])
        ref = db.get_reference(engine, pid, ref["id"])
    db.log(engine, pid, "user", "REFERENCE_APPROVED",
           {"reference_id": ref["id"], "doi": ref["doi"], "label": ref["label"], "title": ref["title"][:200],
            "retraction": ref["retraction"].get("status")})
    return ref


def _store_free_copy(engine, pid: str, rid: str, free: dict, abstract) -> None:
    values = {"oa_info": json.dumps(free)}
    if free.get("status") in ("found", "none"):  # an outage never erases a copy found earlier
        values["oa_pdf_url"] = free.get("url") if free.get("status") == "found" else None
    if abstract:
        values["abstract"] = abstract
    db.set_reference_fields(engine, pid, [rid], **values)


@app.post("/api/projects/{pid}/references/{rid}/free-copy")
def free_copy(pid: str = Path(pattern=ID), rid: str = Path(pattern=ID)):
    """Look up (again) a free legal copy of a Verified reference via OpenAlex."""
    engine = require_db()
    require_project(engine, pid)
    ref = require_reference(engine, pid, rid)
    if ref["label"] != VERIFIED or not ref["doi"]:
        raise HTTPException(409, "Free copies are looked up for Verified references with a DOI.")
    with providers.make_client() as client:
        free, abstract = openaccess.find_free_copy(client, ref["doi"])
    _store_free_copy(engine, pid, rid, free, abstract)
    db.log(engine, pid, "system", "FREE_COPY_CHECKED", {"reference_id": rid, "status": free["status"]})
    return db.get_reference(engine, pid, rid)


@app.get("/api/projects/{pid}/references")
def references(pid: str = Path(pattern=ID), include_trash: bool = Query(default=False)):
    engine = require_db()
    require_project(engine, pid)
    return db.list_references(engine, pid, include_trash=include_trash)


def require_reference(engine, pid: str, rid: str) -> dict:
    ref = db.get_reference(engine, pid, rid)
    if not ref:
        raise HTTPException(404, "Reference not found.")
    return ref


@app.delete("/api/projects/{pid}/references/{rid}")
def remove_reference(pid: str = Path(pattern=ID), rid: str = Path(pattern=ID),
                     permanent: bool = Query(default=False)):
    """Moves a reference to Trash. With permanent=true, deletes a reference that is
    already in Trash for good."""
    engine = require_db()
    require_project(engine, pid)
    ref = require_reference(engine, pid, rid)
    if permanent:
        if not ref.get("deleted_at"):
            raise HTTPException(409, "Move the reference to Trash first, then delete it from Trash.")
        db.delete_references(engine, pid, [rid])
        db.log(engine, pid, "user", "REFERENCE_DELETED", {"reference_id": rid, "title": ref["title"][:200]})
        return {"removed": rid, "permanent": True}
    db.set_reference_fields(engine, pid, [rid], deleted_at=db.utcnow())
    db.log(engine, pid, "user", "REFERENCE_REMOVED", {"reference_id": rid, "title": ref["title"][:200]})
    return {"removed": rid, "permanent": False}


class ReferencePatch(BaseModel):
    favorite: Optional[bool] = None
    read: Optional[bool] = None
    notes: Optional[str] = Field(default=None, max_length=20000)
    trashed: Optional[bool] = None


@app.patch("/api/projects/{pid}/references/{rid}")
def patch_reference(body: ReferencePatch, pid: str = Path(pattern=ID), rid: str = Path(pattern=ID)):
    """Library state only (favourite, read, notes, trash/restore). The trust label and
    the record itself can only change through a live re-check."""
    engine = require_db()
    require_project(engine, pid)
    ref = require_reference(engine, pid, rid)
    values: dict = {}
    if body.favorite is not None:
        values["favorite"] = body.favorite
    if body.read is not None:
        values["read_at"] = db.utcnow() if body.read else None
    if body.notes is not None:
        values["notes"] = body.notes
    if body.trashed is not None:
        values["deleted_at"] = db.utcnow() if body.trashed else None
    db.set_reference_fields(engine, pid, [rid], **values)
    if body.trashed is not None and bool(ref.get("deleted_at")) != body.trashed:
        db.log(engine, pid, "user", "REFERENCE_REMOVED" if body.trashed else "REFERENCE_RESTORED",
               {"reference_id": rid, "title": ref["title"][:200]})
    return db.get_reference(engine, pid, rid)


BULK_ACTIONS = Literal["favorite", "unfavorite", "mark_read", "mark_unread", "trash", "restore",
                       "delete_forever", "add_to_collection", "remove_from_collection"]


class BulkIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    action: BULK_ACTIONS
    collection_id: Optional[str] = Field(default=None, pattern=ID)


@app.post("/api/projects/{pid}/references/bulk")
def bulk_references(body: BulkIn, pid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    if any(not re.fullmatch(r"[0-9a-f]{32}", i) for i in body.ids):
        raise HTTPException(422, "Invalid reference id.")
    refs = db.get_references(engine, pid, list(dict.fromkeys(body.ids)))
    ids = [r["id"] for r in refs]
    if not ids:
        raise HTTPException(404, "None of these references were found.")
    a = body.action
    now = db.utcnow()
    if a in ("add_to_collection", "remove_from_collection"):
        if not body.collection_id or not db.get_collection(engine, pid, body.collection_id):
            raise HTTPException(404, "Collection not found.")
        if a == "add_to_collection":
            changed = db.add_to_collection(engine, pid, body.collection_id, ids)
        else:
            changed = db.remove_from_collection(engine, pid, body.collection_id, ids)
    elif a == "delete_forever":
        trashed = [r["id"] for r in refs if r.get("deleted_at")]
        if len(trashed) != len(ids):
            raise HTTPException(409, "Only references in Trash can be deleted for good.")
        changed = db.delete_references(engine, pid, trashed)
    else:
        values = {"favorite": {"favorite": True}, "unfavorite": {"favorite": False},
                  "mark_read": {"read_at": now}, "mark_unread": {"read_at": None},
                  "trash": {"deleted_at": now}, "restore": {"deleted_at": None}}[a]
        changed = db.set_reference_fields(engine, pid, ids, **values)
    if a in ("trash", "restore", "delete_forever", "add_to_collection", "remove_from_collection"):
        db.log(engine, pid, "user", f"BULK_{a.upper()}",
               {"count": len(ids), "collection_id": body.collection_id})
    return {"action": a, "count": changed, "ids": ids}


# ------------------------------------------------------------------ collections
class CollectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_id: Optional[str] = Field(default=None, pattern=ID)


class CollectionPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    parent_id: Optional[str] = Field(default=None, pattern=ID)
    move_to_top: bool = False


@app.get("/api/projects/{pid}/collections")
def get_collections(pid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    return db.list_collections(engine, pid)


@app.post("/api/projects/{pid}/collections", status_code=201)
def create_collection(body: CollectionIn, pid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Give the collection a name.")
    if body.parent_id and not db.get_collection(engine, pid, body.parent_id):
        raise HTTPException(404, "Parent collection not found.")
    siblings = [c for c in db.list_collections(engine, pid) if c["parent_id"] == body.parent_id]
    if any(c["name"].lower() == name.lower() for c in siblings):
        raise HTTPException(409, "A collection with this name already exists here.")
    col = db.create_collection(engine, pid, name, body.parent_id)
    db.log(engine, pid, "user", "COLLECTION_CREATED", {"collection_id": col["id"], "name": name})
    return col


def _descendants(cols: list[dict], cid: str) -> list[str]:
    out, frontier = [], [cid]
    while frontier:
        nxt = [c["id"] for c in cols if c["parent_id"] in frontier]
        out.extend(nxt)
        frontier = nxt
    return out


@app.patch("/api/projects/{pid}/collections/{cid}")
def patch_collection(body: CollectionPatch, pid: str = Path(pattern=ID), cid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    col = db.get_collection(engine, pid, cid)
    if not col:
        raise HTTPException(404, "Collection not found.")
    values: dict = {}
    if body.name is not None:
        values["name"] = body.name.strip()
    if body.move_to_top:
        values["parent_id"] = None
    elif body.parent_id is not None:
        cols = db.list_collections(engine, pid)
        if body.parent_id == cid or body.parent_id in _descendants(cols, cid):
            raise HTTPException(409, "A collection cannot be moved inside itself.")
        if not db.get_collection(engine, pid, body.parent_id):
            raise HTTPException(404, "Parent collection not found.")
        values["parent_id"] = body.parent_id
    updated = db.update_collection(engine, pid, cid, **values)
    db.log(engine, pid, "user", "COLLECTION_UPDATED", {"collection_id": cid, "name": updated["name"]})
    return updated


@app.delete("/api/projects/{pid}/collections/{cid}")
def delete_collection(pid: str = Path(pattern=ID), cid: str = Path(pattern=ID)):
    """Deletes the collection and its sub-collections. The references stay in the library."""
    engine = require_db()
    require_project(engine, pid)
    col = db.get_collection(engine, pid, cid)
    if not col:
        raise HTTPException(404, "Collection not found.")
    ids = [cid] + _descendants(db.list_collections(engine, pid), cid)
    db.delete_collections(engine, pid, ids)
    db.log(engine, pid, "user", "COLLECTION_DELETED", {"collection_id": cid, "name": col["name"], "count": len(ids)})
    return {"deleted": ids}


# ------------------------------------------------------------------ whole library in one request
@app.get("/api/projects/{pid}/library")
def whole_library(pid: str = Path(pattern=ID)):
    """References (including Trash), collections and duplicate groups together, so the
    page loads with one request instead of three."""
    engine = require_db()
    require_project(engine, pid)
    refs = db.list_references(engine, pid, include_trash=True)
    groups = library.duplicate_groups([r for r in refs if not r.get("deleted_at")])
    return {"references": refs, "collections": db.list_collections(engine, pid),
            "duplicates": {"groups": [[r["id"] for r in g] for g in groups],
                           "rule": library.__doc__.split("\n\n")[1].strip()}}


# ------------------------------------------------------------------ duplicates
@app.get("/api/projects/{pid}/duplicates")
def duplicates(pid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    groups = library.duplicate_groups(db.list_references(engine, pid))
    return {"groups": [[r["id"] for r in g] for g in groups], "rule": library.__doc__.split("\n\n")[1].strip()}


class MergeIn(BaseModel):
    keep_id: str = Field(pattern=ID)
    remove_ids: list[str] = Field(min_length=1, max_length=50)


@app.post("/api/projects/{pid}/duplicates/merge")
def merge_duplicates(body: MergeIn, pid: str = Path(pattern=ID)):
    """Keeps one reference; the others move to Trash (so the merge can be undone).
    Collections, favourite and notes are carried over to the kept reference."""
    engine = require_db()
    require_project(engine, pid)
    if body.keep_id in body.remove_ids or any(not re.fullmatch(r"[0-9a-f]{32}", i) for i in body.remove_ids):
        raise HTTPException(422, "Invalid merge request.")
    keep = require_reference(engine, pid, body.keep_id)
    others = db.get_references(engine, pid, body.remove_ids)
    if len(others) != len(set(body.remove_ids)) or keep.get("deleted_at") or any(o.get("deleted_at") for o in others):
        raise HTTPException(404, "Some of these references were not found in the library.")
    for o in others:
        for cid in o["collection_ids"]:
            db.add_to_collection(engine, pid, cid, [keep["id"]])
    notes = [keep["notes"]] + [f"[Merged from: {o['title'][:120]}]\n{o['notes']}" for o in others if o["notes"]]
    db.set_reference_fields(engine, pid, [keep["id"]],
                            favorite=keep["favorite"] or any(o["favorite"] for o in others),
                            notes="\n\n".join(n for n in notes if n).strip())
    db.set_reference_fields(engine, pid, [o["id"] for o in others], deleted_at=db.utcnow())
    db.log(engine, pid, "user", "REFERENCES_MERGED",
           {"kept": keep["id"], "moved_to_trash": [o["id"] for o in others], "count": len(others)})
    return db.get_reference(engine, pid, keep["id"])


@app.post("/api/projects/{pid}/references/{rid}/recheck")
def recheck_reference(pid: str = Path(pattern=ID), rid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    ref = db.get_reference(engine, pid, rid)
    if not ref:
        raise HTTPException(404, "Reference not found.")
    ui = ref["user_input"] or {}
    if ref["label"] == VERIFIED and ref["doi"]:
        body = CheckIn(mode="doi", doi=ref["doi"])
    elif ui.get("mode") == "text":
        body = CheckIn(mode="text", text=ui.get("text", ""))
    else:
        body = CheckIn(mode=ui.get("mode", "fields") if ui.get("mode") in ("fields", "doi") else "fields",
                       title=ui.get("title", ""), authors=ui.get("authors", ""), year=ui.get("year"),
                       doi=ui.get("doi", ""))
    with providers.make_client() as client:
        result = run_check(client, body)
        if result.label == NOT_FOUND:
            values = dict(ref, label=NOT_FOUND, reason=result.reason, checks=[c.to_dict() for c in result.checks],
                          csl=None, checked_at=result.checked_at)
        else:
            values = _values_from_result(client, result, body)
    other = db.find_reference_by_doi(engine, pid, values["doi"]) if values.get("doi") else None
    if other and other["id"] != rid:
        raise HTTPException(409, "After re-checking, this matches a source already in your list.")
    updated = db.replace_reference(engine, pid, rid, values)
    db.log(engine, pid, "system", "REFERENCE_RECHECKED", {"reference_id": rid, "label": updated["label"]})
    return updated


# ------------------------------------------------------------------ audit log and AI-use summary
@app.get("/api/projects/{pid}/audit")
def audit(pid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    return db.list_events(engine, pid)


@app.post("/api/projects/{pid}/events", status_code=201)
def client_event(body: EventIn, pid: str = Path(pattern=ID)):
    if body.event not in CLIENT_EVENTS:
        raise HTTPException(400, "Unknown event.")
    engine = require_db()
    require_project(engine, pid)
    detail = {k: v for k, v in body.detail.items() if k in {"count", "format", "excluded"}}
    db.log(engine, pid, "user", body.event, detail)
    return {"logged": body.event}


@app.get("/api/projects/{pid}/summary")
def summary(pid: str = Path(pattern=ID)):
    """Counts the AI-use statement is built from: only recorded events, nothing assumed."""
    engine = require_db()
    project = require_project(engine, pid)
    events = db.list_events(engine, pid)
    refs = db.list_references(engine, pid)
    searches = [e for e in events if e["event"] == "SEARCH_RUN" and e["detail"].get("status") == "ok"]
    checks = [e for e in events if e["event"] == "REFERENCE_CHECKED"]
    sources = set()
    for e in searches:
        if e["detail"].get("provider"):
            sources.add(e["detail"]["provider"])
    for e in checks:
        sources.update(e["detail"].get("sources") or [])
    count = lambda label: sum(1 for e in checks if e["detail"].get("label") == label)
    return {
        "project": {"title": project["title"], "question": project["question"]},
        "searches": len(searches),
        "search_providers": sorted({e["detail"].get("provider") for e in searches if e["detail"].get("provider")}),
        "checks": {"total": len(checks), VERIFIED: count(VERIFIED), NOT_FOUND: count(NOT_FOUND),
                   NOT_YET_VERIFIED: count(NOT_YET_VERIFIED)},
        "sources_checked": sorted(sources),
        "references": {"total": len(refs), VERIFIED: sum(1 for r in refs if r["label"] == VERIFIED),
                       NOT_YET_VERIFIED: sum(1 for r in refs if r["label"] == NOT_YET_VERIFIED),
                       NOT_FOUND: sum(1 for r in refs if r["label"] == NOT_FOUND)},
        "approvals": sum(1 for e in events if e["event"] == "REFERENCE_APPROVED"),
        "exports": sum(1 for e in events if e["event"].startswith("EXPORT_")),
        "ai_runs": sum(1 for e in events if e["actor"] == "ai"),
        "first_activity": events[0]["ts"] if events else None,
        "last_activity": events[-1]["ts"] if events else None,
        "generated_at": now_iso(),
    }
