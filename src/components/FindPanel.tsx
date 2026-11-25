import { useState } from "react";
import { api, ApiError } from "../api";
import type { SearchResponse } from "../types";
import { RecordDetails } from "./RecordDetails";
import { TrustLabel } from "./TrustLabel";

interface Props {
  projectId: string;
  onAdded: () => void;
  collectionId?: string | null;
}

export function FindPanel({ projectId, onAdded, collectionId }: Props) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, string>>({});

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true);
    setError("");
    try {
      setRes(await api.search(projectId, q.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  async function approve(doi: string) {
    setAdding(doi);
    setError("");
    try {
      await api.approve(projectId, { mode: "doi", doi }, collectionId);
      setAdded((a) => ({ ...a, [doi]: "added" }));
      onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setAdded((a) => ({ ...a, [doi]: "added" }));
      else setError(err instanceof ApiError ? err.message : "Could not add the source.");
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="panel">
      <h2>Search scholarly databases</h2>
      <p className="hint">Results are live scholarly records. Nothing is added to your library until you approve it.</p>
      <form onSubmit={search} className="search-row" role="search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Topic, title or author" aria-label="Search scholarly records" maxLength={300} />
        <button className="btn-primary" disabled={busy || q.trim().length < 2}>{busy ? "Searching…" : "Search"}</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {res && res.status === "unavailable" && (
        <div className="notice notice-warn" role="status">
          <b>Search could not run.</b> {res.note} No results are shown rather than guessed ones.
        </div>
      )}
      {res && res.status === "ok" && (
        <>
          <p className="meta-line" role="status">
            {res.results.length} results from {res.provider}, retrieved {new Date(res.retrieved_at).toLocaleTimeString()}.
            {res.note ? ` ${res.note}` : ""}
          </p>
          {res.results.length === 0 && <p className="empty">No records matched. Try different words.</p>}
          <ul className="cards">
            {res.results.map((r, i) => {
              const doi = r.record.doi;
              const inList = r.in_list || (doi ? added[doi] === "added" : false);
              return (
                <li key={doi ?? i} className="card">
                  <div className="card-head">
                    <TrustLabel label={r.label} />
                    <span className="card-reason">{r.reason}</span>
                  </div>
                  <RecordDetails record={r.record} />
                  <div className="actions">
                    {doi ? (
                      inList ? (
                        <span className="pill-done">✓ In your library</span>
                      ) : (
                        <button className="btn-primary" onClick={() => approve(doi)} disabled={adding === doi}>
                          {adding === doi ? "Checking and adding…" : "Approve & add to library"}
                        </button>
                      )
                    ) : (
                      <span className="hint">No DOI — use “Check a reference” to add it.</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
