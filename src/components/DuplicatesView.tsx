import { Menu } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "../api";
import { authorShort } from "../lib/library";
import type { Reference } from "../types";
import { TrustLabel } from "./TrustLabel";

interface Props {
  projectId: string;
  groups: string[][];
  byId: Map<string, Reference>;
  rule: string;
  compact: boolean;
  onMenu: () => void;
  onOpen: (id: string) => void;
  onChanged: () => void;
}

/** Possible duplicates, found by code (not AI). Merging keeps one record and moves
 * the others to Trash, so nothing is lost and it can be undone. */
export function DuplicatesView({ projectId, groups, byId, rule, compact, onMenu, onOpen, onChanged }: Props) {
  const [keep, setKeep] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function merge(i: number, ids: string[]) {
    const keepId = keep[i] ?? ids[0];
    setBusy(i);
    setError("");
    try {
      await api.merge(projectId, keepId, ids.filter((x) => x !== keepId));
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Merge failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="library" aria-label="Possible duplicates">
      <div className="lib-toolbar">
        {compact && <button className="icon-btn icon-btn-lg" aria-label="Open library menu" onClick={onMenu}><Menu size={22} /></button>}
        <h2 className="lib-title">Possible duplicates <span className="count">{groups.length}</span></h2>
      </div>
      <p className="hint dup-rule">{rule}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {groups.length === 0 ? (
        <p className="empty">No possible duplicates in your library.</p>
      ) : (
        <ul className="dup-groups">
          {groups.map((ids, i) => (
            <li key={ids.join("-")} className="dup-group">
              <p className="dup-head">These {ids.length} look like the same work. Choose the one to keep:</p>
              {ids.map((id) => {
                const r = byId.get(id);
                if (!r) return null;
                return (
                  <label key={id} className="dup-row">
                    <input type="radio" name={`keep-${i}`} checked={(keep[i] ?? ids[0]) === id} onChange={() => setKeep({ ...keep, [i]: id })} />
                    <span className="dup-main">
                      <span className="dup-title">{r.title}</span>
                      <span className="dup-meta">{authorShort(r.authors)}{r.year ? ` · ${r.year}` : ""}{r.doi ? ` · ${r.doi}` : " · no DOI"}</span>
                    </span>
                    <TrustLabel label={r.label} size="sm" />
                    <button type="button" className="btn-ghost btn-sm" onClick={() => onOpen(id)}>Details</button>
                  </label>
                );
              })}
              <div className="actions">
                <button className="btn-primary btn-sm" onClick={() => merge(i, ids)} disabled={busy === i}>
                  {busy === i ? "Merging…" : "Merge — keep the selected one"}
                </button>
                <span className="hint small">The others move to Trash with their collections, favourite and notes carried over.</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
