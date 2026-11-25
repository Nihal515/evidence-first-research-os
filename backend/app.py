"""FastAPI application: projects, live search, live reference checks,
one-click approval, reference list, audit log and AI-use summary."""
from __future__ import annotations

import os
import re
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db
from . import keycheck
from . import providers
from .labels import LABELS, NOT_FOUND, NOT_YET_VERIFIED, VERIFIED
from .records import normalize_doi, record_from_crossref
from .verify import now_iso, retraction_status, search, verify_fields, verify_text

app = FastAPI(title="Evidence-First Research OS API", version="1.0.0-stage1")

ID = r"^[0-9a-f]{32}$"
CLIENT_EVENTS = {"EXPORT_APA_COPIED", "EXPORT_APA_DOWNLOADED", "STATEMENT_COPIED", "STATEMENT_DOWNLOADED"}


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
    project = db.get_project(engine, pid)
    if not project:
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
    }


@app.get("/api/health/keys")
def health_keys():
    """Tests each saved API key with its provider (cached for 60 s).
    Reports only valid / invalid / not_configured / unavailable — never a key."""
    return keycheck.check_all(providers.make_client)


@app.get("/api/labels")
def labels():
    return LABELS


# ------------------------------------------------------------------ projects
@app.post("/api/projects", status_code=201)
def create_project(body: ProjectIn):
    engine = require_db()
    return db.create_project(engine, body.title.strip(), body.question.strip())


@app.get("/api/projects/{pid}")
def get_project(pid: str = Path(pattern=ID)):
    engine = require_db()
    return require_project(engine, pid)


@app.put("/api/projects/{pid}")
def edit_project(body: ProjectIn, pid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    return db.update_project(engine, pid, body.title.strip(), body.question.strip())


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
        result = run_check(client, body)
        if result.label == NOT_FOUND:
            raise HTTPException(422, {"message": "This reference could not be verified, so it was not added.",
                                      "result": result.to_dict()})
        values = _values_from_result(client, result, body)
    if values["doi"] and db.find_reference_by_doi(engine, pid, values["doi"]):
        raise HTTPException(409, "This source is already in your reference list.")
    ref = db.add_reference(engine, pid, values)
    db.log(engine, pid, "user", "REFERENCE_APPROVED",
           {"reference_id": ref["id"], "doi": ref["doi"], "label": ref["label"], "title": ref["title"][:200],
            "retraction": ref["retraction"].get("status")})
    return ref


@app.get("/api/projects/{pid}/references")
def references(pid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    return db.list_references(engine, pid)


@app.delete("/api/projects/{pid}/references/{rid}")
def remove_reference(pid: str = Path(pattern=ID), rid: str = Path(pattern=ID)):
    engine = require_db()
    require_project(engine, pid)
    ref = db.get_reference(engine, pid, rid)
    if not ref or not db.delete_reference(engine, pid, rid):
        raise HTTPException(404, "Reference not found.")
    db.log(engine, pid, "user", "REFERENCE_REMOVED", {"reference_id": rid, "title": ref["title"][:200]})
    return {"removed": rid}


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
        "exports": sum(1 for e in events if e["event"].startswith("EXPORT_APA")),
        "ai_runs": sum(1 for e in events if e["actor"] == "ai"),
        "first_activity": events[0]["ts"] if events else None,
        "last_activity": events[-1]["ts"] if events else None,
        "generated_at": now_iso(),
    }
