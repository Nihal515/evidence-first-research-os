// "Your paper": upload a draft (.docx, .pdf, .odt, .txt, .md). It is read in the browser and
// never uploaded. Code finds the reference list and the in-text citations and cross-checks
// them; each reference is checked live and gets a trust label; Verified ones can be added to
// the library with one click; the AI Challenger can test each citing sentence.
import { FileUp, ShieldCheck, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { api, ApiError } from "../api";
import { ACCEPT, matchCitation, readPaper, refText, type ParsedPaper } from "../lib/manuscript";
import type { AiClaimCheck, CheckInput, CheckResult, Reference } from "../types";
import { ClaimResult } from "./AiAgents";
import { TrustLabel } from "./TrustLabel";

export interface PaperRow {
  text: string;
  state: "waiting" | "checking" | "checked" | "adding" | "added" | "exists";
  result?: CheckResult;
  error?: string;
  rid?: string;
}
export interface PaperState {
  parsed: ParsedPaper;
  rows: PaperRow[];
}

interface Props {
  projectId: string;
  aiLevel: number;
  library: Reference[];
  value: PaperState | null;
  onChange: (s: PaperState | null) => void;
  onAdded: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BARE_DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i;
const inputFor = (text: string): CheckInput => {
  const t = refText(text);
  const m = t.match(BARE_DOI);
  return m ? { mode: "doi", doi: m[1]! } : { mode: "text", text: t.slice(0, 2000) };
};

export function PaperPanel({ projectId, aiLevel, library, value, onChange, onAdded }: Props) {
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [claims, setClaims] = useState<Record<number, AiClaimCheck | "busy" | string>>({});
  const stop = useRef(false);
  const latest = useRef<PaperState | null>(value);
  latest.current = value;

  const setRow = (i: number, patch: Partial<PaperRow>) => {
    const cur = latest.current;
    if (!cur) return;
    const rows = cur.rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
    latest.current = { ...cur, rows };
    onChange(latest.current);
  };

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError("");
    setClaims({});
    setReading(true);
    try {
      const parsed = await readPaper(file);
      if (!parsed.references.length && !parsed.citations.length) {
        setError("No reference list or in-text citations were found. Check that the references are under a heading such as “References” or “Bibliography”.");
      }
      onChange({ parsed, rows: parsed.references.slice(0, 150).map((text) => ({ text, state: "waiting" })) });
      api.event(projectId, "MANUSCRIPT_SCANNED", { format: parsed.format, references: parsed.references.length,
        citations: parsed.citations.length, words: parsed.words });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file could not be read.");
    } finally {
      setReading(false);
    }
  }

  async function checkAll() {
    if (!latest.current) return;
    stop.current = false;
    setRunning(true);
    for (let i = 0; i < latest.current.rows.length; i++) {
      if (stop.current) break;
      const row = latest.current.rows[i]!;
      if (row.state !== "waiting" && row.result?.label !== "not_yet_verified") continue;
      setRow(i, { state: "checking", error: undefined });
      try {
        const result = await api.check(projectId, inputFor(row.text));
        const doi = result.record?.doi?.toLowerCase();
        const have = doi ? library.find((r) => r.doi?.toLowerCase() === doi && !r.deleted_at) : undefined;
        setRow(i, { state: have ? "exists" : "checked", result, rid: have?.id });
      } catch (e) {
        setRow(i, { state: "waiting", error: e instanceof ApiError ? e.message : "Check failed." });
      }
      await sleep(300); // stay inside the registries' public rate limits
    }
    setRunning(false);
  }

  async function add(i: number) {
    const row = latest.current?.rows[i];
    if (!row) return;
    setRow(i, { state: "adding", error: undefined });
    try {
      const ref = await api.approve(projectId, inputFor(row.text));
      setRow(i, { state: "added", rid: ref.id });
      onAdded();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const doi = row.result?.record?.doi?.toLowerCase();
        setRow(i, { state: "exists", rid: library.find((r) => r.doi?.toLowerCase() === doi)?.id });
      } else setRow(i, { state: "checked", error: e instanceof ApiError ? e.message : "Could not add." });
    }
  }

  async function addAllVerified() {
    const rows = latest.current?.rows ?? [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.state === "checked" && rows[i]!.result?.label === "verified") {
        await add(i);
        await sleep(200);
      }
    }
  }

  async function checkSentence(ci: number, rid: string, sentence: string) {
    setClaims((c) => ({ ...c, [ci]: "busy" }));
    try {
      const res = await api.aiClaim(projectId, rid, sentence.slice(0, 1000));
      setClaims((c) => ({ ...c, [ci]: res }));
    } catch (e) {
      setClaims((c) => ({ ...c, [ci]: e instanceof ApiError ? e.message : "The AI could not answer." }));
    }
  }

  const p = value?.parsed;
  const rows = value?.rows ?? [];
  const links = p ? p.citations.map((c) => matchCitation(c, p.references, p.numbered)) : [];
  const citedRefs = new Set(links.flat());
  const missing = links.filter((l) => l.length === 0).length;
  const uncited = p ? p.references.map((_, i) => i).filter((i) => !citedRefs.has(i)) : [];
  const counts = rows.reduce((a, r) => { if (r.result) a[r.result.label] = (a[r.result.label] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const checked = rows.filter((r) => r.result).length;
  const verifiedReady = rows.filter((r) => r.state === "checked" && r.result?.label === "verified").length;

  return (
    <div className="page paper">
      <header className="page-head">
        <h1><FileUp size={22} aria-hidden="true" /> Your paper</h1>
        <p className="hint">Upload your draft to check its references and citations. Paper Trail finds the reference list, checks every
          reference live, cross-checks each in-text citation against the list, and lets you add the real sources to your library.</p>
      </header>

      <section className="panel">
        <label className="file-drop paper-drop" onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]); }}>
          <FileUp size={22} aria-hidden="true" />
          <span>{reading ? "Reading your paper…" : p ? `Loaded ${p.fileName} · choose another file` : "Choose or drop your paper: Word (.docx), PDF, .odt, .txt or .md"}</span>
          <input type="file" accept={ACCEPT} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }}
            aria-label="Upload your paper (.docx, .pdf, .odt, .txt or .md)" disabled={reading} />
        </label>
        <p className="hint small"><ShieldCheck size={13} aria-hidden="true" /> Your file is read in this browser and never uploaded.
          Only each reference line is sent to be checked, and a sentence only if you ask the AI to check it.</p>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {p && (
        <>
          <section className="panel">
            <ul className="lab-tiles paper-tiles">
              <li><b>{p.references.length}</b><span>References{p.heading ? ` under “${p.heading}”` : " found"}</span></li>
              <li><b>{p.citations.length}</b><span>In-text citations</span></li>
              <li data-tone={missing ? "bad" : undefined}><b>{missing}</b><span>Cited but not in your list</span></li>
              <li data-tone={uncited.length ? "warn" : undefined}><b>{uncited.length}</b><span>Listed but never cited</span></li>
              <li><b>{counts.verified ?? 0}</b><span>Verified</span></li>
              <li data-tone={counts.not_found ? "bad" : undefined}><b>{counts.not_found ?? 0}</b><span>Not found</span></li>
            </ul>
            <p className="hint small">{p.words.toLocaleString()} words read · {p.format.toUpperCase()} ·
              {p.numbered ? " numbered reference list" : " author–year citations"}. Finding and cross-checking is plain code; no AI.</p>
          </section>

          <section className="panel">
            <h2 className="panel-title">References in your paper</h2>
            {rows.length > 0 && (
              <div className="actions">
                {running ? (
                  <button className="btn-secondary" onClick={() => { stop.current = true; }}>Stop checking</button>
                ) : (
                  <button className="btn-primary" onClick={checkAll} disabled={rows.every((r) => r.result && r.result.label !== "not_yet_verified")}>
                    Check {checked ? "the rest" : `all ${rows.length}`} live
                  </button>
                )}
                {verifiedReady > 0 && !running && <button className="btn-secondary" onClick={addAllVerified}>Add all {verifiedReady} Verified to my library</button>}
                <span className="meta-line" role="status">{checked} of {rows.length} checked</span>
              </div>
            )}
            <ol className="paper-refs">
              {rows.map((r, i) => (
                <li key={i} className="import-row" id={`paper-ref-${i + 1}`}>
                  <div className="import-main">
                    <span className="paper-ref-text"><b>{i + 1}.</b> {refText(r.text)}</span>
                    {r.result && <span className="import-reason"><TrustLabel label={r.result.label} size="sm" /> {r.result.reason}</span>}
                    {uncited.includes(i) && <span className="hint small">Not cited anywhere in your text.</span>}
                    {r.error && <span className="error small">{r.error}</span>}
                  </div>
                  <div className="import-side">
                    {r.state === "waiting" && <span className="hint small">Not checked yet</span>}
                    {r.state === "checking" && <span className="hint small">Checking live…</span>}
                    {r.state === "adding" && <span className="hint small">Adding…</span>}
                    {r.state === "added" && <span className="pill-done">✓ Added</span>}
                    {r.state === "exists" && <span className="pill-done">✓ In your library</span>}
                    {r.state === "checked" && r.result && r.result.label !== "not_found" && (
                      <button className="btn-secondary btn-sm" onClick={() => add(i)}>Add to library</button>
                    )}
                    {r.state === "checked" && r.result?.label === "not_found" && <span className="hint small">Cannot be added</span>}
                  </div>
                </li>
              ))}
            </ol>
            {!rows.length && <p className="empty">No reference list was found in this file.</p>}
          </section>

          <section className="panel">
            <h2 className="panel-title">Citations in your text</h2>
            {!p.citations.length && <p className="empty">No in-text citations such as (Author, 2020) or [1] were found.</p>}
            <ul className="paper-cites">
              {p.citations.map((c, ci) => {
                const hit = links[ci] ?? [];
                const ref = hit.length === 1 ? rows[hit[0]!] : undefined;
                const label = ref?.result?.label;
                const claim = claims[ci];
                const canAi = ref?.rid && label === "verified";
                return (
                  <li key={ci} className="paper-cite" data-ok={hit.length > 0}>
                    <div className="paper-cite-head">
                      <code>{c.text}</code>
                      {hit.length ? (
                        <span className="hint small">→ reference {hit.map((h) => `#${h + 1}`).join(", ")}{label && <> · <TrustLabel label={label} size="sm" /></>}</span>
                      ) : (
                        <span className="paper-miss">✕ Not in your reference list</span>
                      )}
                    </div>
                    <p className="paper-sentence">{c.sentence}</p>
                    {hit.length === 1 && aiLevel >= 3 && (
                      canAi ? (
                        <button className="btn-ghost btn-sm" disabled={claim === "busy"} onClick={() => checkSentence(ci, ref!.rid!, c.sentence)}>
                          <Sparkles size={14} aria-hidden="true" /> {claim === "busy" ? "Checking…" : "Check this sentence with AI"}
                        </button>
                      ) : (
                        <span className="hint small">Check and add reference #{hit[0]! + 1} to test this sentence with AI.</span>
                      )
                    )}
                    {claim && typeof claim === "object" && <ClaimResult res={claim} />}
                    {typeof claim === "string" && claim !== "busy" && <p className="error small" role="alert">{claim}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
