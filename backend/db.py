"""Database tables and access (PostgreSQL on Neon in production, SQLite in tests)."""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    create_engine,
    delete,
    insert,
    select,
    update,
)
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool

metadata = MetaData()

projects = Table(
    "projects",
    metadata,
    Column("id", String(32), primary_key=True),
    Column("title", String(300), nullable=False),
    Column("question", Text, nullable=False, default=""),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

project_references = Table(
    "project_references",
    metadata,
    Column("id", String(32), primary_key=True),
    Column("project_id", String(32), nullable=False, index=True),
    Column("label", String(32), nullable=False),
    Column("reason", Text, nullable=False, default=""),
    Column("doi", String(300), nullable=True),
    Column("title", Text, nullable=False),
    Column("authors", Text, nullable=False, default="[]"),
    Column("year", Integer, nullable=True),
    Column("container", Text, nullable=False, default=""),
    Column("provider", String(40), nullable=False, default=""),
    Column("csl", Text, nullable=True),
    Column("checks", Text, nullable=False, default="[]"),
    Column("retraction", Text, nullable=False, default="{}"),
    Column("user_input", Text, nullable=False, default="{}"),
    Column("checked_at", String(40), nullable=False),
    Column("approved_at", DateTime(timezone=True), nullable=False),
    UniqueConstraint("project_id", "doi", name="uq_project_doi"),
)

audit_events = Table(
    "audit_events",
    metadata,
    Column("id", String(32), primary_key=True),
    Column("project_id", String(32), nullable=False, index=True),
    Column("ts", DateTime(timezone=True), nullable=False),
    Column("actor", String(16), nullable=False),
    Column("event", String(60), nullable=False),
    Column("detail", Text, nullable=False, default="{}"),
)

_engine: Optional[Engine] = None
_engine_url: Optional[str] = None


def database_url() -> str:
    url = (os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL") or "").strip()
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def get_engine() -> Optional[Engine]:
    """Create the engine once per process and make sure the tables exist."""
    global _engine, _engine_url
    url = database_url()
    if not url:
        return None
    if _engine is None or _engine_url != url:
        kwargs = {"poolclass": NullPool} if url.startswith("postgresql") else {}
        _engine = create_engine(url, **kwargs)
        _engine_url = url
        metadata.create_all(_engine)
    return _engine


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt) -> Optional[str]:
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ------------------------------------------------------------------ projects
def create_project(engine: Engine, title: str, question: str) -> dict:
    pid, now = new_id(), utcnow()
    with engine.begin() as conn:
        conn.execute(insert(projects).values(id=pid, title=title, question=question, created_at=now, updated_at=now))
    log(engine, pid, "user", "PROJECT_CREATED", {"title": title})
    return get_project(engine, pid)


def get_project(engine: Engine, pid: str) -> Optional[dict]:
    with engine.connect() as conn:
        row = conn.execute(select(projects).where(projects.c.id == pid)).mappings().first()
    if not row:
        return None
    return {"id": row["id"], "title": row["title"], "question": row["question"],
            "created_at": iso(row["created_at"]), "updated_at": iso(row["updated_at"])}


def update_project(engine: Engine, pid: str, title: str, question: str) -> Optional[dict]:
    with engine.begin() as conn:
        conn.execute(update(projects).where(projects.c.id == pid)
                     .values(title=title, question=question, updated_at=utcnow()))
    log(engine, pid, "user", "PROJECT_UPDATED", {"title": title})
    return get_project(engine, pid)


# ------------------------------------------------------------------ references
def _ref_row(row) -> dict:
    return {
        "id": row["id"],
        "label": row["label"],
        "reason": row["reason"],
        "doi": row["doi"],
        "title": row["title"],
        "authors": json.loads(row["authors"] or "[]"),
        "year": row["year"],
        "container": row["container"],
        "provider": row["provider"],
        "csl": json.loads(row["csl"]) if row["csl"] else None,
        "checks": json.loads(row["checks"] or "[]"),
        "retraction": json.loads(row["retraction"] or "{}"),
        "user_input": json.loads(row["user_input"] or "{}"),
        "checked_at": row["checked_at"],
        "approved_at": iso(row["approved_at"]),
    }


def list_references(engine: Engine, pid: str) -> list[dict]:
    with engine.connect() as conn:
        rows = conn.execute(select(project_references).where(project_references.c.project_id == pid)
                            .order_by(project_references.c.approved_at)).mappings().all()
    return [_ref_row(r) for r in rows]


def find_reference_by_doi(engine: Engine, pid: str, doi: str) -> Optional[dict]:
    with engine.connect() as conn:
        row = conn.execute(select(project_references).where(
            (project_references.c.project_id == pid) & (project_references.c.doi == doi))).mappings().first()
    return _ref_row(row) if row else None


def add_reference(engine: Engine, pid: str, values: dict) -> dict:
    rid = new_id()
    row = {
        "id": rid,
        "project_id": pid,
        "label": values["label"],
        "reason": values.get("reason", ""),
        "doi": values.get("doi"),
        "title": values["title"],
        "authors": json.dumps(values.get("authors") or []),
        "year": values.get("year"),
        "container": values.get("container") or "",
        "provider": values.get("provider") or "",
        "csl": json.dumps(values["csl"]) if values.get("csl") else None,
        "checks": json.dumps(values.get("checks") or []),
        "retraction": json.dumps(values.get("retraction") or {}),
        "user_input": json.dumps(values.get("user_input") or {}),
        "checked_at": values["checked_at"],
        "approved_at": utcnow(),
    }
    with engine.begin() as conn:
        conn.execute(insert(project_references).values(**row))
    return get_reference(engine, pid, rid)


def get_reference(engine: Engine, pid: str, rid: str) -> Optional[dict]:
    with engine.connect() as conn:
        row = conn.execute(select(project_references).where(
            (project_references.c.project_id == pid) & (project_references.c.id == rid))).mappings().first()
    return _ref_row(row) if row else None


def replace_reference(engine: Engine, pid: str, rid: str, values: dict) -> Optional[dict]:
    with engine.begin() as conn:
        conn.execute(update(project_references).where(
            (project_references.c.project_id == pid) & (project_references.c.id == rid)).values(
            label=values["label"], reason=values.get("reason", ""), doi=values.get("doi"), title=values["title"],
            authors=json.dumps(values.get("authors") or []), year=values.get("year"),
            container=values.get("container") or "", provider=values.get("provider") or "",
            csl=json.dumps(values["csl"]) if values.get("csl") else None,
            checks=json.dumps(values.get("checks") or []), retraction=json.dumps(values.get("retraction") or {}),
            checked_at=values["checked_at"]))
    return get_reference(engine, pid, rid)


def delete_reference(engine: Engine, pid: str, rid: str) -> bool:
    with engine.begin() as conn:
        res = conn.execute(delete(project_references).where(
            (project_references.c.project_id == pid) & (project_references.c.id == rid)))
    return res.rowcount > 0


# ------------------------------------------------------------------ audit log (append-only)
def log(engine: Engine, pid: str, actor: str, event: str, detail: dict) -> None:
    with engine.begin() as conn:
        conn.execute(insert(audit_events).values(id=new_id(), project_id=pid, ts=utcnow(), actor=actor,
                                                 event=event, detail=json.dumps(detail)))


def list_events(engine: Engine, pid: str) -> list[dict]:
    with engine.connect() as conn:
        rows = conn.execute(select(audit_events).where(audit_events.c.project_id == pid)
                            .order_by(audit_events.c.ts)).mappings().all()
    return [{"ts": iso(r["ts"]), "actor": r["actor"], "event": r["event"], "detail": json.loads(r["detail"] or "{}")}
            for r in rows]
