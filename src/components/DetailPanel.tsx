import { ArrowLeft, BookOpenCheck, Copy, ExternalLink, FileText, FolderPlus, RotateCcw, Search, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { LABELS } from "../labels";
import { apaFor } from "../lib/exportActions";
import { copyText } from "../lib/exporters";
import { collectionTree, flattenTree } from "../lib/library";
import type { Collection, Reference } from "../types";
import { AiSourceTools } from "./AiAgents";
import { TrustLabel } from "./TrustLabel";

interface Props {
  projectId: string;
  reference: Reference;
  collections: Collection[];
  compact: boolean;
  onClose: () => void;
  onChanged: (r?: Reference) => void;
  aiLevel?: number;
}

const STATUS_TEXT = { match: "Matches", mismatch: "Does not match", not_provided: "Not entered" } as const;
const RETRACTION: Record<string, { text: string; cls: string }> = {
  retracted: { text: "Retracted", cls: "chip-red" },
  concern: { text: "Expression of concern", cls: "chip-amber" },
  corrected: { text: "Correction published", cls: "chip-grey" },
  none_found: { text: "No retraction notice found", cls: "chip-grey" },
  unknown: { text: "Retraction status unknown", cls: "chip-amber" },
};

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export function DetailPanel({ projectId, reference: r, collections, compact, onClose, onChanged, aiLevel = 3 }: Props) {
  const [notes, setNotes] = useState(r.notes);
  const [notesState, setNotesState] = useState<"" | "saving" | "saved">("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setNotes(r.notes);
    setNotesState("");
    setError("");
    setMsg("");
    setConfirm(false);
    setAdding(false);
  }, [r.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const apa = useMemo(() => apaFor(r), [r.id, r.label, r.checked_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = useMemo(() => flattenTree(collectionTree(collections)), [collections]);
  const mine = flat.filter((c) => r.collection_ids.includes(c.id));
  const others = flat.filter((c) => !r.collection_ids.includes(c.id));
  const trashed = Boolean(r.deleted_at);
  const ret = RETRACTION[r.retraction?.status ?? ""];

  async function run(key: string, fn: () => Promise<Reference | void>, done?: string) {
    setBusy(key);
    setError("");
    setMsg("");
    try {
      const updated = await fn();
      onChanged(updated || undefined);
      if (done) setMsg(done);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function saveNotes() {
    if (notes === r.notes) return;
    setNotesState("saving");
    try {
      onChanged(await api.patch(projectId, r.id, { notes }));
      setNotesState("saved");
    } catch {
      setNotesState("");
      setError("Notes were not saved. Please try again.");
    }
  }

  async function copyCitation() {
    if (!apa) return;
    const ok = await copyText(apa.text, `<p style="padding-left:0.5in;text-indent:-0.5in">${apa.html}</p>`);
    setMsg(ok ? "APA 7 reference copied." : "Copy failed.");
    if (ok) api.event(projectId, "EXPORT_APA_COPIED", { count: 1, excluded: 0 });
  }

  return (
    <aside className={compact ? "detail detail-sheet" : "detail"} aria-label="Reference details" role={compact ? "dialog" : undefined}
      aria-modal={compact ? true : undefined}>
      <div className="detail-head">
        <button className="icon-btn" onClick={onClose} aria-label={compact ? "Back to library" : "Close details"}>
          {compact ? <ArrowLeft size={20} /> : <X size={18} />}
        </button>
        <span className="detail-head-title">Details</span>
        {!trashed && (
          <button className={`icon-btn star${r.favorite ? " star-on" : ""}`} aria-pressed={r.favorite}
            aria-label={r.favorite ? "Remove from favourites" : "Add to favourites"}
            onClick={() => run("fav", () => api.patch(projectId, r.id, { favorite: !r.favorite }))}>
            <Star size={18} />
          </button>
        )}
      </div>

      <div className="detail-body">
        <div className="detail-labels">
          <TrustLabel label={r.label} />
          {ret && <span className={`chip ${ret.cls}`} title={r.retraction?.detail}>{ret.text}</span>}
        </div>
        <p className="detail-meaning">{LABELS[r.label].meaning}</p>

        <h3 className="detail-title">{r.title}</h3>
        <p className="detail-authors">{r.authors.length ? r.authors.join(", ") : "No authors listed"}</p>
        <dl className="detail-meta">
          {r.year && (<><dt>Year</dt><dd>{r.year}</dd></>)}
          {r.container && (<><dt>Source</dt><dd>{r.container}</dd></>)}
          {r.doi && (<><dt>DOI</dt><dd><a href={`https://doi.org/${r.doi}`} target="_blank" rel="noopener noreferrer">{r.doi} <ExternalLink size={12} /></a></dd></>)}
          {r.provider && (<><dt>Record from</dt><dd>{r.provider}</dd></>)}
        </dl>

        {r.doi && !trashed && (
          <div className="actions">
            <a className="btn-primary btn-sm" href={`https://doi.org/${r.doi}`} target="_blank" rel="noopener noreferrer"
              onClick={() => { if (!r.read_at) api.patch(projectId, r.id, { read: true }).then((u) => onChanged(u)).catch(() => undefined); }}>
              <ExternalLink size={14} /> Open article (doi.org)
            </a>
          </div>
        )}

        {r.retraction?.status === "retracted" && (
          <p className="warn-line" role="note">⚠ {r.retraction.detail} Do not rely on its findings.</p>
        )}
        {r.retraction?.status === "unknown" && (
          <p className="hint small">The retraction check could not run last time. Use <b>Check again</b>.</p>
        )}

        <section className="detail-section">
          <h4>Why this label</h4>
          <p className="detail-reason">{r.reason}</p>
          {r.checks.length > 0 && (
            <table className="checks">
              <thead><tr><th>Field</th><th>Result</th><th>Details</th></tr></thead>
              <tbody>
                {r.checks.map((c) => (
                  <tr key={c.field} className={`chk-${c.status}`}>
                    <td>{c.field}</td><td>{STATUS_TEXT[c.status]}</td><td>{c.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="meta-line">Checked {new Date(r.checked_at).toLocaleString()} · approved by you {new Date(r.approved_at).toLocaleString()}</p>
          {!trashed && (
            <button className="btn-secondary btn-sm" disabled={busy === "recheck"}
              onClick={() => run("recheck", () => api.recheck(projectId, r.id), "Checked again live.")}>
              <RotateCcw size={14} /> {busy === "recheck" ? "Checking live…" : "Check again"}
            </button>
          )}
        </section>

        {!trashed && (
          <section className="detail-section">
            <h4>AI help <span className="hint small">· AI suggestions, checked by code</span></h4>
            <AiSourceTools projectId={projectId} reference={r} aiLevel={aiLevel} onChanged={onChanged} />
          </section>
        )}

        {!trashed && r.label === "verified" && r.doi && (
          <section className="detail-section">
            <h4>Free legal copy</h4>
            {r.free_copy?.status === "found" && r.free_copy.url ? (
              <>
                <a className="btn-secondary btn-sm free-link" href={r.free_copy.url} target="_blank" rel="noopener noreferrer"
                  onClick={() => { if (!r.read_at) api.patch(projectId, r.id, { read: true }).then((u) => onChanged(u)).catch(() => undefined); }}>
                  <FileText size={14} /> Open {r.free_copy.is_pdf ? "PDF" : "free copy"} <ExternalLink size={12} />
                </a>
                <p className="hint small">
                  {capital(r.free_copy.version_text || "version not stated")}
                  {r.free_copy.host ? `, from ${r.free_copy.host}` : ""}{r.free_copy.license ? ` · licence: ${r.free_copy.license}` : ""}.
                  {r.free_copy.version && r.free_copy.version !== "publishedVersion"
                    ? " This may differ from the published article — cite the published version." : ""}
                  {" "}Found by OpenAlex.
                </p>
              </>
            ) : (
              <p className="hint small">
                {r.free_copy?.status === "none" && "No free legal copy was found by OpenAlex."}
                {r.free_copy?.status === "unavailable" && "OpenAlex could not be reached last time."}
                {!r.free_copy && "Not looked up yet."}
              </p>
            )}
            {r.free_copy?.checked_at && <p className="meta-line">Checked {new Date(r.free_copy.checked_at).toLocaleString()}</p>}
            {(!r.free_copy || r.free_copy.status !== "found") && (
              <button className="btn-ghost btn-sm" disabled={busy === "oa"}
                onClick={() => run("oa", () => api.freeCopy(projectId, r.id))}>
                <Search size={14} /> {busy === "oa" ? "Looking…" : r.free_copy ? "Look again" : "Find a free legal copy"}
              </button>
            )}
          </section>
        )}

        {!trashed && (
          <section className="detail-section">
            <h4>Cite (APA 7)</h4>
            {apa ? (
              <>
                <p className="apa-entry apa-one" dangerouslySetInnerHTML={{ __html: apa.html }} />
                <button className="btn-ghost btn-sm" onClick={copyCitation}><Copy size={14} /> Copy reference</button>
              </>
            ) : (
              <p className="hint small">Only Verified references are formatted. Check this one again first.</p>
            )}
          </section>
        )}

        {!trashed && (
          <section className="detail-section">
            <h4>Collections</h4>
            <div className="chips">
              {mine.map((c) => (
                <span key={c.id} className="chip chip-coll">
                  {c.name}
                  <button className="icon-btn" aria-label={`Remove from ${c.name}`}
                    onClick={() => run("coll", async () => { await api.bulk(projectId, [r.id], "remove_from_collection", c.id); })}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              {!mine.length && <span className="hint small">Not in any collection (Unsorted).</span>}
            </div>
            {others.length > 0 && (adding ? (
              <select autoFocus className="select" aria-label="Add to collection" defaultValue=""
                onChange={(e) => { const cid = e.target.value; setAdding(false); if (cid) run("coll", async () => { await api.bulk(projectId, [r.id], "add_to_collection", cid); }); }}
                onBlur={() => setAdding(false)}>
                <option value="" disabled>Choose a collection…</option>
                {others.map((c) => <option key={c.id} value={c.id}>{"  ".repeat(c.depth)}{c.name}</option>)}
              </select>
            ) : (
              <button className="btn-ghost btn-sm" onClick={() => setAdding(true)}><FolderPlus size={14} /> Add to collection</button>
            ))}
          </section>
        )}

        {!trashed && (
          <section className="detail-section">
            <h4>Notes</h4>
            <textarea className="notes" value={notes} maxLength={20000} rows={4} placeholder="Your notes on this source"
              aria-label="Notes" onChange={(e) => { setNotes(e.target.value); setNotesState(""); }} onBlur={saveNotes} />
            <p className="hint small" role="status">{notesState === "saving" ? "Saving…" : notesState === "saved" ? "Saved." : "Saved when you click away."}</p>
          </section>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        {msg && <p className="success" role="status">{msg}</p>}

        <div className="detail-actions">
          {!trashed ? (
            <>
              <button className="btn-ghost btn-sm" disabled={busy === "read"}
                onClick={() => run("read", () => api.patch(projectId, r.id, { read: !r.read_at }))}>
                <BookOpenCheck size={14} /> {r.read_at ? "Mark as unread" : "Mark as read"}
              </button>
              <button className="btn-ghost btn-sm btn-danger-text" disabled={busy === "trash"}
                onClick={() => run("trash", async () => { await api.remove(projectId, r.id); onClose(); })}>
                <Trash2 size={14} /> Move to Trash
              </button>
            </>
          ) : (
            <>
              <button className="btn-secondary btn-sm" disabled={busy === "restore"}
                onClick={() => run("restore", () => api.patch(projectId, r.id, { trashed: false }), "Restored to your library.")}>
                <RotateCcw size={14} /> Restore
              </button>
              {confirm ? (
                <>
                  <button className="btn-danger btn-sm" onClick={() => run("del", async () => { await api.remove(projectId, r.id, true); onClose(); })}>
                    Delete forever
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => setConfirm(false)}>Cancel</button>
                  <p className="hint small">This cannot be undone.</p>
                </>
              ) : (
                <button className="btn-ghost btn-sm btn-danger-text" onClick={() => setConfirm(true)}><Trash2 size={14} /> Delete forever…</button>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
