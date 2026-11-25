"""Database tables and access (PostgreSQL on Neon in production, SQLite in tests)."""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    String,
    Table,
    Text,
    UniqueConstraint,
    create_engine,
    delete,
    false,
    inspect,
    insert,
    select,
    text,
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
    Column("owner_id", String(64), nullable=True, index=True),  # set when a signed-in user owns the project
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
    # library state (added in the library stage; migrated in place, never dropped)
    Column("favorite", Boolean, nullable=False, server_default=false()),
    Column("read_at", DateTime(timezone=True), nullable=True),
    Column("deleted_at", DateTime(timezone=True), nullable=True),  # set = in Trash
    Column("notes", Text, nullable=True),
    Column("abstract", Text, nullable=True),
    Column("oa_pdf_url", Text, nullable=True),      # free legal copy found by OpenAlex
    Column("pdf_pathname", Text, nullable=True),    # the user's own uploaded PDF (private storage)
    UniqueConstraint("project_id", "doi", name="uq_project_doi"),
)

collections = Table(
    "collections",
    metadata,
    Column("id", String(32), primary_key=True),
    Column("project_id", String(32), nullable=False, index=True),
    Column("name", String(120), nullable=False),
    Column("parent_id", String(32), nullable=True),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

reference_collections = Table(
    "reference_collections",
    metadata,
    Column("reference_id", String(32), nullable=False),
    Column("collection_id", String(32), nullable=False, index=True),
    Column("project_id", String(32), nullable=False, index=True),
    PrimaryKeyConstraint("reference_id", "collection_id", name="pk_reference_collection"),
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


SCHEMA_LOCK_KEY = 4172026  # Postgres advisory lock: one instance sets up the schema at a time


def get_engine() -> Optional[Engine]:
    """Create the engine once per process and make sure the schema is up to date."""
    global _engine, _engine_url
    url = database_url()
    if not url:
        return None
    if _engine is None or _engine_url != url:
        kwargs = {"poolclass": NullPool} if url.startswith("postgresql") else {}
        engine = create_engine(url, **kwargs)
        _ensure_schema(engine)
        _engine, _engine_url = engine, url  # only remembered once the schema is ready
    return _engine


def _schema_is_current(conn) -> bool:
    insp = inspect(conn)
    tables = set(insp.get_table_names())
    for table in metadata.sorted_tables:
        if table.name not in tables:
            return False
        have = {c["name"] for c in insp.get_columns(table.name)}
        if any(col.name not in have for col in table.columns):
            return False
    return True


def _ensure_schema(engine: Engine) -> None:
    """Create or migrate the schema only when something is missing. The normal case
    (schema already current) takes no lock and runs no DDL, so cold starts stay fast."""
    is_pg = engine.dialect.name == "postgresql"
    with engine.connect() as conn:
        if _schema_is_current(conn):
            conn.rollback()
            return
        conn.rollback()
        if is_pg:
            # never wait forever on a lock: fail fast and let the next request retry
            conn.execute(text("SET lock_timeout = '10s'"))
            conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": SCHEMA_LOCK_KEY})
            conn.commit()
        try:
            metadata.create_all(conn)
            _add_missing_columns(conn)
            conn.commit()
        finally:
            if is_pg:
                conn.rollback()
                conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": SCHEMA_LOCK_KEY})
                conn.commit()


def _add_missing_columns(conn) -> None:
    """Safe in-place migration: add any column that exists in the code but not yet in
    the database. Existing tables and rows are never dropped or rewritten."""
    insp = inspect(conn)
    dialect = conn.dialect
    for table in metadata.sorted_tables:
        existing = {c["name"] for c in insp.get_columns(table.name)}
        for col in table.columns:
            if col.name in existing:
                continue
            ddl_type = col.type.compile(dialect=dialect)
            default = ""
            if col.server_default is not None:
                if isinstance(col.type, Boolean):
                    default = " DEFAULT 0" if dialect.name == "sqlite" else " DEFAULT false"
                else:
                    default = " DEFAULT ''"
            null = "" if col.nullable else " NOT NULL"
            # IF NOT EXISTS (Postgres) keeps a repeated migration harmless.
            guard = " IF NOT EXISTS" if dialect.name == "postgresql" else ""
            conn.execute(text(f"ALTER TABLE {table.name} ADD COLUMN{guard} {col.name} {ddl_type}{default}{null}"))


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
        "favorite": bool(row["favorite"]),
        "read_at": iso(row["read_at"]),
        "deleted_at": iso(row["deleted_at"]),
        "notes": row["notes"] or "",
        "abstract": row["abstract"],
        "oa_pdf_url": row["oa_pdf_url"],
        "has_uploaded_pdf": bool(row["pdf_pathname"]),
        "collection_ids": [],
    }


def _memberships(conn, pid: str) -> dict:
    out: dict = {}
    for r in conn.execute(select(reference_collections).where(reference_collections.c.project_id == pid)).mappings():
        out.setdefault(r["reference_id"], []).append(r["collection_id"])
    return out


def _with_collections(conn, pid: str, refs: list[dict]) -> list[dict]:
    members = _memberships(conn, pid)
    for ref in refs:
        ref["collection_ids"] = sorted(members.get(ref["id"], []))
    return refs


def list_references(engine: Engine, pid: str, include_trash: bool = False) -> list[dict]:
    q = select(project_references).where(project_references.c.project_id == pid)
    if not include_trash:
        q = q.where(project_references.c.deleted_at.is_(None))
    with engine.connect() as conn:
        rows = conn.execute(q.order_by(project_references.c.approved_at)).mappings().all()
        return _with_collections(conn, pid, [_ref_row(r) for r in rows])


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
        if not row:
            return None
        return _with_collections(conn, pid, [_ref_row(row)])[0]


def get_references(engine: Engine, pid: str, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    with engine.connect() as conn:
        rows = conn.execute(select(project_references).where(
            (project_references.c.project_id == pid) & (project_references.c.id.in_(ids)))).mappings().all()
        return _with_collections(conn, pid, [_ref_row(r) for r in rows])


def set_reference_fields(engine: Engine, pid: str, ids: list[str], **values) -> int:
    """Update library fields (favorite, read_at, deleted_at, notes, abstract, oa_pdf_url, pdf_pathname)."""
    allowed = {"favorite", "read_at", "deleted_at", "notes", "abstract", "oa_pdf_url", "pdf_pathname"}
    values = {k: v for k, v in values.items() if k in allowed}
    if not ids or not values:
        return 0
    with engine.begin() as conn:
        res = conn.execute(update(project_references).where(
            (project_references.c.project_id == pid) & (project_references.c.id.in_(ids))).values(**values))
    return res.rowcount


def delete_references(engine: Engine, pid: str, ids: list[str]) -> int:
    if not ids:
        return 0
    with engine.begin() as conn:
        conn.execute(delete(reference_collections).where(
            (reference_collections.c.project_id == pid) & (reference_collections.c.reference_id.in_(ids))))
        res = conn.execute(delete(project_references).where(
            (project_references.c.project_id == pid) & (project_references.c.id.in_(ids))))
    return res.rowcount


# ------------------------------------------------------------------ collections
def _collection_row(row) -> dict:
    return {"id": row["id"], "name": row["name"], "parent_id": row["parent_id"], "created_at": iso(row["created_at"])}


def list_collections(engine: Engine, pid: str) -> list[dict]:
    with engine.connect() as conn:
        rows = conn.execute(select(collections).where(collections.c.project_id == pid)
                            .order_by(collections.c.name)).mappings().all()
    return [_collection_row(r) for r in rows]


def get_collection(engine: Engine, pid: str, cid: str) -> Optional[dict]:
    with engine.connect() as conn:
        row = conn.execute(select(collections).where(
            (collections.c.project_id == pid) & (collections.c.id == cid))).mappings().first()
    return _collection_row(row) if row else None


def create_collection(engine: Engine, pid: str, name: str, parent_id: Optional[str]) -> dict:
    cid = new_id()
    with engine.begin() as conn:
        conn.execute(insert(collections).values(id=cid, project_id=pid, name=name, parent_id=parent_id,
                                                created_at=utcnow()))
    return get_collection(engine, pid, cid)


def update_collection(engine: Engine, pid: str, cid: str, **values) -> Optional[dict]:
    values = {k: v for k, v in values.items() if k in {"name", "parent_id"}}
    if values:
        with engine.begin() as conn:
            conn.execute(update(collections).where(
                (collections.c.project_id == pid) & (collections.c.id == cid)).values(**values))
    return get_collection(engine, pid, cid)


def delete_collections(engine: Engine, pid: str, cids: list[str]) -> None:
    """Delete collections (and their memberships). References themselves are kept."""
    with engine.begin() as conn:
        conn.execute(delete(reference_collections).where(
            (reference_collections.c.project_id == pid) & (reference_collections.c.collection_id.in_(cids))))
        conn.execute(delete(collections).where((collections.c.project_id == pid) & (collections.c.id.in_(cids))))


def add_to_collection(engine: Engine, pid: str, cid: str, rids: list[str]) -> int:
    with engine.begin() as conn:
        have = {r[0] for r in conn.execute(select(reference_collections.c.reference_id).where(
            (reference_collections.c.collection_id == cid) & (reference_collections.c.reference_id.in_(rids))))}
        new = [r for r in rids if r not in have]
        for rid in new:
            conn.execute(insert(reference_collections).values(reference_id=rid, collection_id=cid, project_id=pid))
    return len(new)


def remove_from_collection(engine: Engine, pid: str, cid: str, rids: list[str]) -> int:
    with engine.begin() as conn:
        res = conn.execute(delete(reference_collections).where(
            (reference_collections.c.project_id == pid) & (reference_collections.c.collection_id == cid)
            & (reference_collections.c.reference_id.in_(rids))))
    return res.rowcount


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
    return delete_references(engine, pid, [rid]) > 0


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
