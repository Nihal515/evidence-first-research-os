import { FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { importInput, parseImport, parsePlainList, type ImportedItem } from "../lib/citations";
import type { CheckResult } from "../types";
import { TrustLabel } from "./TrustLabel";

interface Props {
  projectId: string;
  onAdded: () => void;
  collectionId?: string | null;
  initialText?: string; // a list handed over from the landing page or the Check link
}

interface Row {
  item: ImportedItem;
  result?: CheckResult;
  error?: string;
  state: "waiting" | "checking" | "checked" | "adding" | "added" | "exists";
}

const MAX_ITEMS = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Import from Mendeley, Zotero, EndNote or Google Scholar (BibTeX / RIS). Every
 * item is checked live; nothing is added until you approve it. */
export function ImportPanel({ projectId, onAdded, collectionId, initialText = "" }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [pasted, setPasted] = useState(initialText);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const stop = useRef(false);

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    setError("");
    if (!file) return;
    if (file.size > 2_000_000) return setError("That file is larger than 2 MB. Export a smaller set of references.");
    const items = parseImport(file.name, await file.text());
    if (!items.length) return setError("No references were found in that file. Use a BibTeX (.bib) or RIS (.ris) export.");
    setFileName(file.name);
    setRows(items.slice(0, MAX_ITEMS).map((item) => ({ item, state: "waiting" })));
    if (items.length > MAX_ITEMS) setError(`Only the first ${MAX_ITEMS} of ${items.length} references were loaded.`);
  }

  function loadPasted(text: string) {
    setError("");
    const items = parsePlainList(text);
    if (!items.length) return setError("No references found. Put one reference, DOI or title per line.");
    setFileName("");
    setRows(items.slice(0, MAX_ITEMS).map((item) => ({ item, state: "waiting" })));
    if (items.length > MAX_ITEMS) setError(`Only the first ${MAX_ITEMS} of ${items.length} references were loaded.`);
  }

  // a handed-over list loads straight away; the person still presses Check
  useEffect(() => {
    if (initialText.trim()) loadPasted(initialText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkAll() {
    setRunning(true);
    stop.current = false;
    for (let i = 0; i < rows.length; i++) {
      if (stop.current) break;
      if (rows[i].state !== "waiting" && !(rows[i].result?.label === "not_yet_verified")) continue;
      update(i, { state: "checking", error: undefined });
      try {
        const result = await api.check(projectId, importInput(rows[i].item));
        update(i, { state: result.in_list ? "exists" : "checked", result });
      } catch (err) {
        update(i, { state: "waiting", error: err instanceof ApiError ? err.message : "Check failed." });
      }
      await sleep(350); // stay well inside Crossref's public rate limit
    }
    setRunning(false);
  }

  async function approve(i: number) {
    update(i, { state: "adding", error: undefined });
    try {
      const ref = await api.approve(projectId, importInput(rows[i].item), collectionId);
      update(i, { state: "added", error: rows[i].result?.label === "verified" && ref.label !== "verified"
        ? "Added as Not yet verified: a database was busy. Use Check again in your library." : undefined });
      onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) update(i, { state: "exists" });
      else if (err instanceof ApiError && err.status === 422 && err.result) update(i, { state: "checked", result: err.result, error: err.message });
      else update(i, { state: "checked", error: err instanceof ApiError ? err.message : "Could not add." });
    }
  }

  async function approveAllVerified() {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].state === "checked" && rows[i].result?.label === "verified") {
        await approve(i);
        await sleep(200);
      }
    }
  }

  const checked = rows.filter((r) => r.result).length;
  const verifiedReady = rows.filter((r) => r.state === "checked" && r.result?.label === "verified").length;
  const counts = rows.reduce((acc, r) => {
    if (r.result) acc[r.result.label] = (acc[r.result.label] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="panel">
      <h2>Import or paste a list</h2>
      <p className="hint">
        Export your library from Mendeley, Zotero, EndNote or Google Scholar as <b>BibTeX (.bib)</b> or <b>RIS (.ris)</b>.
        Each reference is checked live — a made-up one is labelled Not found and cannot be added. Nothing is added until you approve it.
      </p>
      <label className="file-drop">
        <FileUp size={20} aria-hidden="true" />
        <span>{fileName ? `Loaded ${fileName} · choose another file` : "Choose a .bib or .ris file"}</span>
        <input type="file" accept=".bib,.ris,.txt,.bibtex" onChange={onFile} aria-label="Choose a BibTeX or RIS file" />
      </label>
      <div className="paste-list">
        <label htmlFor="paste-list" className="field-label">Or paste a reference list, one per line</label>
        <textarea id="paste-list" rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)}
          placeholder={"Bloom, N., Liang, J., Roberts, J., & Ying, Z. J. (2015). Does working from home work? …\n10.1126/science.adh2586"} />
        <div className="actions">
          <button className="btn-secondary btn-sm" onClick={() => loadPasted(pasted)} disabled={!pasted.trim() || running}>Load the list</button>
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {rows.length > 0 && (
        <>
          <div className="actions">
            {running ? (
              <button className="btn-secondary" onClick={() => { stop.current = true; }}>Stop checking</button>
            ) : (
              <button className="btn-primary" onClick={checkAll} disabled={rows.every((r) => r.result && r.result.label !== "not_yet_verified")}>
                Check {checked ? "the rest" : `all ${rows.length}`} live
              </button>
            )}
            {verifiedReady > 0 && !running && (
              <button className="btn-secondary" onClick={approveAllVerified}>Approve all {verifiedReady} Verified</button>
            )}
          </div>
          <p className="meta-line" role="status">
            {checked} of {rows.length} checked
            {counts.verified ? ` · ${counts.verified} Verified` : ""}
            {counts.not_found ? ` · ${counts.not_found} Not found` : ""}
            {counts.not_yet_verified ? ` · ${counts.not_yet_verified} Not yet verified` : ""}
          </p>
          <ul className="import-list">
            {rows.map((r, i) => (
              <li key={i} className="import-row">
                <div className="import-main">
                  <span className="import-title">{r.item.title || `DOI ${r.item.doi}`}</span>
                  <span className="import-meta">{r.item.raw ? "Pasted reference, checked as written" : <>{r.item.authors || "No authors"}{r.item.year ? ` · ${r.item.year}` : ""}{r.item.doi ? ` · ${r.item.doi}` : ""}</>}</span>
                  {r.result && <span className="import-reason">{r.result.reason}</span>}
                  {r.error && <span className="error small">{r.error}</span>}
                </div>
                <div className="import-side">
                  {r.state === "waiting" && <span className="hint small">Waiting</span>}
                  {r.state === "checking" && <span className="hint small">Checking live…</span>}
                  {r.result && <TrustLabel label={r.result.label} size="sm" />}
                  {r.state === "checked" && r.result?.label === "verified" && (
                    <button className="btn-primary btn-sm" onClick={() => approve(i)}>Approve</button>
                  )}
                  {r.state === "checked" && r.result?.label === "not_yet_verified" && (
                    <button className="btn-ghost btn-sm" onClick={() => approve(i)}>Add as Not yet verified</button>
                  )}
                  {r.state === "checked" && r.result?.label === "not_found" && <span className="blocked small">Not added</span>}
                  {r.state === "adding" && <span className="hint small">Adding…</span>}
                  {r.state === "added" && <span className="pill-done">✓ Added</span>}
                  {r.state === "exists" && <span className="pill-done">✓ Already in library</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
