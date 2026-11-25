import { useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { formatBibliography } from "../lib/apa";
import { copyText, downloadBlob, referencesDocx } from "../lib/exporters";
import type { Reference } from "../types";
import { authorLine } from "./RecordDetails";
import { TrustLabel } from "./TrustLabel";

interface Props {
  projectId: string;
  references: Reference[];
  onChange: () => void;
}

const RETRACTION_TEXT: Record<string, string> = {
  retracted: "Retracted",
  concern: "Expression of concern",
  corrected: "Correction published",
  none_found: "No retraction notice found",
  unknown: "Retraction status unknown",
};

export function ReferencesPanel({ projectId, references, onChange }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const exportable = references.filter((r) => r.label === "verified" && r.csl);
  const excluded = references.filter((r) => !(r.label === "verified" && r.csl));

  const { html, text, failed } = useMemo(() => {
    try {
      const items = exportable.map((r) => r.csl!);
      return { html: formatBibliography(items, "html"), text: formatBibliography(items, "text"), failed: false };
    } catch {
      return { html: [] as string[], text: [] as string[], failed: true };
    }
  }, [exportable.map((r) => r.id).join(",")]);

  async function recheck(r: Reference) {
    setBusy(r.id);
    setError("");
    try {
      await api.recheck(projectId, r.id);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Re-check failed.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(r: Reference) {
    setBusy(r.id);
    try {
      await api.remove(projectId, r.id);
      setConfirmRemove(null);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove the reference.");
    } finally {
      setBusy(null);
    }
  }

  async function copyApa() {
    const plain = text.join("\n\n");
    const rich = `<p style="text-align:center"><b>References</b></p>` +
      html.map((h) => `<p style="padding-left:0.5in;text-indent:-0.5in">${h}</p>`).join("");
    const ok = await copyText(plain, rich);
    setMessage(ok ? `Copied ${text.length} APA 7 reference${text.length === 1 ? "" : "s"}.` : "Copy failed — use Download instead.");
    if (ok) api.event(projectId, "EXPORT_APA_COPIED", { count: text.length, excluded: excluded.length });
  }

  async function downloadDocx() {
    downloadBlob(await referencesDocx(html), "references-apa7.docx");
    setMessage("Downloaded references-apa7.docx.");
    api.event(projectId, "EXPORT_APA_DOWNLOADED", { count: html.length, format: "docx", excluded: excluded.length });
  }

  function downloadTxt() {
    downloadBlob(new Blob(["References\n\n" + text.join("\n\n") + "\n"], { type: "text/plain;charset=utf-8" }), "references-apa7.txt");
    setMessage("Downloaded references-apa7.txt.");
    api.event(projectId, "EXPORT_APA_DOWNLOADED", { count: text.length, format: "txt", excluded: excluded.length });
  }

  return (
    <div className="panel">
      <h2>My references <span className="count">{references.length}</span></h2>
      <p className="hint">Every source here was approved by you. Labels show how far to trust each one.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {references.length === 0 && (
        <p className="empty">No references yet. Use <b>Find sources</b> or <b>Check a reference</b>, then approve the ones you want.</p>
      )}
      <ul className="cards">
        {references.map((r) => (
          <li key={r.id} className="card">
            <div className="card-head">
              <TrustLabel label={r.label} />
              {r.retraction?.status && (
                <span className={`badge badge-${r.retraction.status}`} title={r.retraction.detail}>
                  {RETRACTION_TEXT[r.retraction.status] ?? r.retraction.status}
                </span>
              )}
            </div>
            <p className="record-title">{r.title}</p>
            <p className="record-meta">
              {authorLine(r.authors)}{r.year ? ` · ${r.year}` : ""}{r.container ? ` · ${r.container}` : ""}
            </p>
            {r.doi && (
              <p className="record-meta">
                DOI: <a href={`https://doi.org/${r.doi}`} target="_blank" rel="noopener noreferrer">{r.doi}</a>
              </p>
            )}
            <p className="card-reason">{r.reason}</p>
            {r.retraction?.status === "retracted" && (
              <p className="warn-line" role="note">⚠ {r.retraction.detail} Do not rely on its findings.</p>
            )}
            <p className="meta-line">Approved {new Date(r.approved_at).toLocaleString()} · checked {new Date(r.checked_at).toLocaleString()}</p>
            <div className="actions">
              {r.label !== "verified" && (
                <button className="btn-secondary" onClick={() => recheck(r)} disabled={busy === r.id}>
                  {busy === r.id ? "Checking…" : "Check again"}
                </button>
              )}
              {confirmRemove === r.id ? (
                <>
                  <button className="btn-danger" onClick={() => remove(r)} disabled={busy === r.id}>Yes, remove</button>
                  <button className="btn-ghost" onClick={() => setConfirmRemove(null)}>Cancel</button>
                </>
              ) : (
                <button className="btn-ghost" onClick={() => setConfirmRemove(r.id)}>Remove</button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <section className="export" aria-labelledby="apa-title">
        <h3 id="apa-title">Reference list — APA 7th edition</h3>
        {failed && <p className="error">The formatter could not build the list. Please reload the page.</p>}
        {!failed && exportable.length === 0 && <p className="empty">Approve a Verified source to build your APA 7 list.</p>}
        {!failed && exportable.length > 0 && (
          <>
            <div className="apa-preview">
              <p className="apa-heading">References</p>
              {html.map((h, i) => <p key={i} className="apa-entry" dangerouslySetInnerHTML={{ __html: h }} />)}
            </div>
            <div className="actions">
              <button className="btn-primary" onClick={copyApa}>Copy APA 7 list</button>
              <button className="btn-secondary" onClick={downloadDocx}>Download Word (.docx)</button>
              <button className="btn-ghost" onClick={downloadTxt}>Download text (.txt)</button>
            </div>
            {message && <p className="success" role="status">{message}</p>}
            <p className="hint small">
              Formatted by citeproc-js with the official APA 7 style from each publisher’s registered metadata. APA uses
              sentence case for article titles; titles appear as the publisher registered them, so check capitalisation
              before you submit.
            </p>
          </>
        )}
        {excluded.length > 0 && (
          <p className="notice notice-warn">
            {excluded.length} reference{excluded.length === 1 ? " is" : "s are"} left out of the APA list because{" "}
            {excluded.length === 1 ? "it is" : "they are"} not verified. Use <b>Check again</b> first.
          </p>
        )}
      </section>
    </div>
  );
}
