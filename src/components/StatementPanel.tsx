import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { copyText, downloadBlob } from "../lib/exporters";
import { buildStatement } from "../lib/statement";
import type { AuditEvent } from "../types";

const EVENT_TEXT: Record<string, string> = {
  PROJECT_CREATED: "Project created",
  PROJECT_UPDATED: "Project updated",
  SEARCH_RUN: "Searched scholarly records",
  REFERENCE_CHECKED: "Checked a reference live",
  REFERENCE_APPROVED: "You approved a source",
  REFERENCE_REMOVED: "You moved a source to Trash",
  REFERENCE_RESTORED: "You restored a source from Trash",
  REFERENCE_DELETED: "You deleted a source for good",
  REFERENCE_RECHECKED: "Re-checked a source",
  REFERENCES_MERGED: "You merged duplicate sources",
  COLLECTION_CREATED: "You created a collection",
  COLLECTION_UPDATED: "You changed a collection",
  COLLECTION_DELETED: "You deleted a collection",
  BULK_TRASH: "You moved sources to Trash",
  BULK_RESTORE: "You restored sources from Trash",
  BULK_DELETE_FOREVER: "You deleted sources for good",
  BULK_ADD_TO_COLLECTION: "You filed sources in a collection",
  BULK_REMOVE_FROM_COLLECTION: "You removed sources from a collection",
  EXPORT_APA_COPIED: "Copied the APA 7 list",
  EXPORT_APA_DOWNLOADED: "Downloaded the APA 7 list",
  EXPORT_BIBTEX_DOWNLOADED: "Downloaded BibTeX",
  EXPORT_RIS_DOWNLOADED: "Downloaded RIS",
  FREE_COPY_CHECKED: "Looked up a free legal copy",
  STATEMENT_COPIED: "Copied the AI-use statement",
  STATEMENT_DOWNLOADED: "Downloaded the AI-use statement",
};

const LABEL_WORD: Record<string, string> = {
  verified: "Verified",
  not_found: "Not found",
  not_yet_verified: "Not yet verified",
};

function describe(e: AuditEvent): string {
  const d = e.detail as Record<string, any>;
  if (e.event === "SEARCH_RUN") return `“${d.query}” · ${d.results} results from ${d.provider ?? "no source (unavailable)"}`;
  if (e.event === "REFERENCE_CHECKED") return `${LABEL_WORD[d.label] ?? d.label} · ${(d.sources || []).join(", ") || "no source answered"}`;
  if (e.event === "REFERENCE_APPROVED") return `${LABEL_WORD[d.label] ?? d.label} · ${d.title ?? ""}`;
  if (["REFERENCE_REMOVED", "REFERENCE_RESTORED", "REFERENCE_DELETED"].includes(e.event)) return d.title ?? "";
  if (e.event.startsWith("COLLECTION_")) return d.name ?? "";
  if (e.event.startsWith("BULK_") || e.event === "REFERENCES_MERGED") return `${d.count ?? 0} sources`;
  if (e.event.startsWith("EXPORT")) return `${d.count ?? 0} references${d.format ? ` · ${d.format}` : ""}`;
  return "";
}

export function StatementPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [statement, setStatement] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([api.summary(projectId), api.audit(projectId)])
      .then(([s, ev]) => {
        if (!live) return;
        setStatement(buildStatement(s));
        setEvents(ev);
        setError("");
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : "Could not load your activity."))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [projectId, refreshKey]);

  async function copy() {
    const ok = await copyText(statement);
    setMessage(ok ? "Copied — paste it into your assignment." : "Copy failed — use Download instead.");
    if (ok) api.event(projectId, "STATEMENT_COPIED");
  }

  function download() {
    downloadBlob(new Blob([statement + "\n"], { type: "text/plain;charset=utf-8" }), "ai-use-statement.txt");
    setMessage("Downloaded ai-use-statement.txt.");
    api.event(projectId, "STATEMENT_DOWNLOADED");
  }

  return (
    <div className="panel">
      <h2>AI-use statement</h2>
      <p className="hint">
        Built only from what this tool actually recorded in your activity log below. Paste it into your assignment and
        edit it if you also used other tools.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {loading && !statement && <p className="empty">Building your statement…</p>}
      {statement && (
        <>
          <textarea className="statement" value={statement} readOnly rows={9} aria-label="AI-use statement" />
          <div className="actions">
            <button className="btn-primary" onClick={copy}>Copy statement</button>
            <button className="btn-secondary" onClick={download}>Download (.txt)</button>
          </div>
          {message && <p className="success" role="status">{message}</p>}
        </>
      )}
      <h3>Activity log</h3>
      <p className="hint small">Append-only record of what happened in this project, newest first.</p>
      <ol className="log">
        {[...events].reverse().map((e, i) => (
          <li key={i}>
            <span className="log-time">{new Date(e.ts).toLocaleString()}</span>
            <span className="log-event">{EVENT_TEXT[e.event] ?? e.event}</span>
            <span className="log-detail">{describe(e)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
