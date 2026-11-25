import { useState } from "react";
import { api, ApiError } from "../api";
import { LABELS } from "../labels";
import type { CheckInput, CheckResult } from "../types";
import { RecordDetails } from "./RecordDetails";
import { TrustLabel } from "./TrustLabel";

interface Props {
  projectId: string;
  onAdded: () => void;
}

const STATUS_TEXT = { match: "Matches", mismatch: "Does not match", not_provided: "Not entered" } as const;

export function CheckPanel({ projectId, onAdded }: Props) {
  const [mode, setMode] = useState<"fields" | "text">("fields");
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState("");
  const [year, setYear] = useState("");
  const [doi, setDoi] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [lastInput, setLastInput] = useState<CheckInput | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  function input(): CheckInput | null {
    if (mode === "text") return text.trim() ? { mode: "text", text: text.trim() } : null;
    const y = year.trim() ? Number(year.trim()) : null;
    if (y !== null && (!Number.isInteger(y) || y < 1500 || y > 2100)) {
      setError("Enter the year as four digits, for example 2015.");
      return null;
    }
    if (!title.trim() && !doi.trim()) {
      setError("Enter at least a title or a DOI.");
      return null;
    }
    return { mode: "fields", title: title.trim(), authors: authors.trim(), year: y, doi: doi.trim() };
  }

  async function check(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    const inp = lastInput && !e ? lastInput : input();
    if (!inp) {
      if (mode === "text" && !text.trim()) setError("Paste a reference first.");
      return;
    }
    setBusy(true);
    setResult(null);
    setAdded(false);
    try {
      const r = await api.check(projectId, inp);
      setResult(r);
      setLastInput(inp);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The check failed.");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!lastInput) return;
    setAdding(true);
    setError("");
    try {
      await api.approve(projectId, lastInput);
      setAdded(true);
      onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.result) {
        setResult(err.result);
        setError(err.message);
      } else if (err instanceof ApiError && err.status === 409) {
        setAdded(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Could not add the reference.");
      }
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="panel">
      <h2>Check a reference</h2>
      <p className="hint">
        Paste or type any reference — for example one an AI tool gave you. It is checked live against Crossref, doi.org
        and OpenAlex. A reference is only labelled <b>Verified</b> when a real record matches what you entered.
      </p>

      <div className="segmented" role="tablist" aria-label="How to enter the reference">
        <button role="tab" aria-selected={mode === "fields"} className={mode === "fields" ? "seg-on" : ""}
          onClick={() => { setMode("fields"); setResult(null); setError(""); }}>Enter details</button>
        <button role="tab" aria-selected={mode === "text"} className={mode === "text" ? "seg-on" : ""}
          onClick={() => { setMode("text"); setResult(null); setError(""); }}>Paste a reference</button>
      </div>

      <form onSubmit={check} className="form">
        {mode === "fields" ? (
          <>
            <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} placeholder="e.g. Deep learning" /></label>
            <label>Authors<input value={authors} onChange={(e) => setAuthors(e.target.value)} maxLength={1000} placeholder="e.g. LeCun, Y., Bengio, Y., & Hinton, G." /></label>
            <div className="row-2">
              <label>Year<input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" maxLength={4} placeholder="2015" /></label>
              <label>DOI <span className="optional">(optional)</span><input value={doi} onChange={(e) => setDoi(e.target.value)} maxLength={300} placeholder="10.1038/nature14539" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
            </div>
          </>
        ) : (
          <label>
            Full reference or DOI
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={2000}
              placeholder="e.g. LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444." />
          </label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn-primary" disabled={busy}>{busy ? "Checking live…" : "Check live"}</button>
        </div>
      </form>

      {result && (
        <section className={`result result-${result.label}`} aria-live="polite">
          <div className="card-head">
            <TrustLabel label={result.label} />
            <span className="result-meaning">{LABELS[result.label].meaning}</span>
          </div>
          <p className="result-reason">{result.reason}</p>

          {result.checks.length > 0 && (
            <table className="checks">
              <thead><tr><th>Field</th><th>Result</th><th>Details</th></tr></thead>
              <tbody>
                {result.checks.map((c) => (
                  <tr key={c.field} className={`chk-${c.status}`}>
                    <td>{c.field}</td>
                    <td>{STATUS_TEXT[c.status]}</td>
                    <td>{c.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {result.record && (
            <>
              <p className="sub-title">{result.label === "verified" ? "Matched record" : "Closest real record"}</p>
              <RecordDetails record={result.record} />
            </>
          )}

          <p className="meta-line">
            Checked {new Date(result.checked_at).toLocaleString()} ·{" "}
            {result.sources_checked.length ? `sources checked: ${result.sources_checked.join(", ")}` : "no source could be checked"}
            {result.unavailable.length ? ` · unavailable: ${result.unavailable.join("; ")}` : ""}
          </p>

          <div className="actions">
            {result.label === "verified" && (added || result.in_list ? (
              <span className="pill-done">✓ In your reference list</span>
            ) : (
              <button className="btn-primary" onClick={approve} disabled={adding}>
                {adding ? "Adding…" : "Approve & add to my references"}
              </button>
            ))}
            {result.label === "not_yet_verified" && (
              <>
                <button className="btn-primary" onClick={() => check()} disabled={busy}>Check again</button>
                {added ? (
                  <span className="pill-done">✓ Added as Not yet verified</span>
                ) : (
                  <button className="btn-secondary" onClick={approve} disabled={adding}>
                    {adding ? "Adding…" : "Add anyway as Not yet verified"}
                  </button>
                )}
              </>
            )}
            {result.label === "not_found" && (
              <p className="blocked" role="status">
                Not added. A reference that could not be verified cannot go into your reference list.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
