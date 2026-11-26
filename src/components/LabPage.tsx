// Integrity Lab: run a fixed corpus of 24 cases (12 real, 12 invented) through the live
// checker, one at a time, and report every outcome by family. Ported in spirit from
// Team 1's Paper Trail Lab; the cases come from the server (GET /api/lab) and each run
// goes through the same checker the workspace uses (POST /api/lab/run).
import { FlaskConical, Play, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { LabCase, LabCorpus, LabOutcome, LabRun } from "../types";
import { TrustLabel } from "./TrustLabel";

type Status = "not-run" | "active" | "done" | "error" | "cancelled";
type CaseState = { status: Status; run?: LabRun; error?: string };

const OUTCOME_TEXT: Record<LabOutcome, string> = {
  correct: "Real matched",
  "expected-retraction": "Expected retraction",
  caught: "Caught",
  missed: "Missed",
  "false-alarm": "False alarm",
  "could-not-check": "Could not check",
};
const OUTCOME_TONE: Record<LabOutcome, string> = {
  correct: "ok",
  "expected-retraction": "ok",
  caught: "ok",
  missed: "bad",
  "false-alarm": "bad",
  "could-not-check": "warn",
};

const COLUMNS = [
  "Family", "Cases", "Real matched", "Expected retraction", "Caught", "Missed", "False alarm",
  "Could not check", "Other unresolved / error", "Active", "Cancelled", "Not run", "Coverage gaps",
] as const;

function tally(cases: LabCase[], state: Record<string, CaseState>) {
  const t = { cases: cases.length, correct: 0, "expected-retraction": 0, caught: 0, missed: 0, "false-alarm": 0,
    "could-not-check": 0, error: 0, active: 0, cancelled: 0, notRun: 0, gaps: 0 };
  for (const c of cases) {
    const s = state[c.id] ?? { status: "not-run" };
    if (s.status === "not-run") t.notRun++;
    else if (s.status === "active") t.active++;
    else if (s.status === "cancelled") t.cancelled++;
    else if (s.status === "error") t.error++;
    else if (s.run) {
      t[s.run.evaluation.outcome]++;
      if (s.run.evaluation.limited_coverage) t.gaps++;
    }
  }
  return t;
}

export function LabPage() {
  const [corpus, setCorpus] = useState<LabCorpus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [state, setState] = useState<Record<string, CaseState>>({});
  const [running, setRunning] = useState(false);
  const [finishedAt, setFinishedAt] = useState("");
  const cancel = useRef(false);

  useEffect(() => {
    api.lab().then(setCorpus).catch((e) => setLoadError(e instanceof ApiError ? e.message : "Could not load the Lab corpus."));
    return () => {
      cancel.current = true; // leaving the page stops the run after the current case
    };
  }, []);

  const set = (id: string, s: CaseState) => setState((m) => ({ ...m, [id]: s }));

  async function runAll() {
    if (!corpus) return;
    cancel.current = false;
    setRunning(true);
    setFinishedAt("");
    setState(Object.fromEntries(corpus.cases.map((c) => [c.id, { status: "not-run" as Status }])));
    for (let i = 0; i < corpus.cases.length; i++) {
      const c = corpus.cases[i]!;
      if (cancel.current) {
        for (const rest of corpus.cases.slice(i)) set(rest.id, { status: "cancelled" });
        break;
      }
      set(c.id, { status: "active" });
      try {
        set(c.id, { status: "done", run: await api.labRun(c.id) });
      } catch (e) {
        set(c.id, { status: "error", error: e instanceof ApiError ? e.message : "The request failed." });
      }
    }
    setRunning(false);
    setFinishedAt(new Date().toLocaleString());
  }

  const families = corpus?.families ?? [];
  const rows = useMemo(
    () => (corpus ? families.map((f) => ({ f, t: tally(corpus.cases.filter((c) => c.family === f.id), state) })) : []),
    [corpus, families, state],
  );
  const total = useMemo(() => (corpus ? tally(corpus.cases, state) : null), [corpus, state]);
  const activeIndex = corpus ? corpus.cases.findIndex((c) => state[c.id]?.status === "active") : -1;

  return (
    <div className="page lab">
      <header className="page-head">
        <h1><FlaskConical size={22} aria-hidden="true" /> Integrity Lab</h1>
        <p className="hint">
          A fixed test of the checker: 12 real references captured from Crossref and 12 invented by code from them.
          Run all 24 through the live checker and see what it catches. Every case is kept, whatever the result.
        </p>
      </header>

      {loadError && <div className="notice notice-warn" role="alert">{loadError}</div>}
      {!corpus && !loadError && <p className="empty">Loading the corpus…</p>}

      {corpus && total && (
        <>
          <section className="panel">
            <div className="actions">
              {!running ? (
                <button className="btn-primary" onClick={runAll}>
                  <Play size={16} aria-hidden="true" /> {finishedAt ? "Run all 24 again" : "Run all 24 live"}
                </button>
              ) : (
                <button className="btn-danger" onClick={() => (cancel.current = true)}>
                  <Square size={14} aria-hidden="true" /> Cancel
                </button>
              )}
              <span className="hint" role="status" aria-live="polite">
                {running
                  ? activeIndex >= 0 ? `Checking case ${activeIndex + 1} of ${corpus.cases.length} against the live databases…` : "Stopping…"
                  : finishedAt
                    ? `Finished ${finishedAt}. ${total.correct + total["expected-retraction"]} of 12 real handled correctly, ${total.caught} of 12 invented caught, ${total.missed} missed, ${total["false-alarm"]} false alarm${total["false-alarm"] === 1 ? "" : "s"}.`
                    : "Nothing has run yet. Each run makes live requests to Crossref, doi.org and OpenAlex."}
              </span>
            </div>
            <ul className="lab-tiles">
              {(["correct", "expected-retraction", "caught", "missed", "false-alarm", "could-not-check"] as LabOutcome[]).map((o) => (
                <li key={o} data-tone={total[o] > 0 ? OUTCOME_TONE[o] : undefined}>
                  <b>{total[o]}</b>
                  <span>{OUTCOME_TEXT[o]}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <h2 className="panel-title">Results by family</h2>
            <div className="lab-scroll" tabIndex={0} role="region" aria-label="Results by family table">
              <table className="lab-table">
                <thead>
                  <tr>{COLUMNS.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map(({ f, t }) => (
                    <tr key={f.id}>
                      <th scope="row">{f.label}</th>
                      <td>{t.cases}</td><td>{t.correct}</td><td>{t["expected-retraction"]}</td><td>{t.caught}</td>
                      <td data-bad={t.missed > 0}>{t.missed}</td><td data-bad={t["false-alarm"] > 0}>{t["false-alarm"]}</td>
                      <td>{t["could-not-check"]}</td><td>{t.error}</td><td>{t.active}</td><td>{t.cancelled}</td>
                      <td>{t.notRun}</td><td>{t.gaps}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">All</th>
                    <td>{total.cases}</td><td>{total.correct}</td><td>{total["expected-retraction"]}</td><td>{total.caught}</td>
                    <td data-bad={total.missed > 0}>{total.missed}</td><td data-bad={total["false-alarm"] > 0}>{total["false-alarm"]}</td>
                    <td>{total["could-not-check"]}</td><td>{total.error}</td><td>{total.active}</td><td>{total.cancelled}</td>
                    <td>{total.notRun}</td><td>{total.gaps}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="hint">
              Could not check means a database did not answer, so the case is unresolved — it is never counted as a success.
              A coverage gap means at least one database did not answer during that case.
            </p>
          </section>

          <section className="panel">
            <h2 className="panel-title">Every case and its evidence</h2>
            <ol className="lab-cases">
              {corpus.cases.map((c, n) => <CaseRow key={c.id} n={n + 1} c={c} s={state[c.id] ?? { status: "not-run" }} />)}
            </ol>
          </section>

          <section className="panel">
            <h2 className="panel-title">How the corpus was made</h2>
            <dl className="lab-manifest">
              <dt>Source</dt><dd>{corpus.manifest.source}</dd>
              <dt>Selection rule</dt><dd>{corpus.manifest.selection_rule}</dd>
              <dt>Generation rule</dt><dd>{corpus.manifest.generation_rule}</dd>
            </dl>
            <h3 className="sub-title">Limits</h3>
            <ul className="lab-limits">{corpus.manifest.limits.map((l) => <li key={l}>{l}</li>)}</ul>
          </section>
        </>
      )}
    </div>
  );
}

function CaseRow({ n, c, s }: { n: number; c: LabCase; s: CaseState }) {
  const run = s.run;
  const outcome = run?.evaluation.outcome;
  return (
    <li className="lab-case" data-status={s.status}>
      <details>
        <summary>
          <span className="lab-n">{n}</span>
          <span className="lab-case-title">
            <b>{c.title}</b>
            <span className="hint">{c.family_label} · {c.invented ? "Invented for this Lab; do not cite" : c.label}</span>
          </span>
          <span className="lab-result">
            {s.status === "done" && outcome && <span className={`lab-pill lab-${OUTCOME_TONE[outcome]}`}>{OUTCOME_TEXT[outcome]}</span>}
            {s.status === "active" && <span className="lab-pill">Checking…</span>}
            {s.status === "error" && <span className="lab-pill lab-warn">Error</span>}
            {s.status === "cancelled" && <span className="lab-pill">Cancelled</span>}
            {s.status === "not-run" && <span className="lab-pill lab-mute">Not run</span>}
          </span>
        </summary>
        <dl className="lab-evidence">
          <dt>Input</dt><dd className="mono">{c.reference.raw}</dd>
          <dt>Expected</dt><dd>{c.expected_text}</dd>
          <dt>How it was made</dt><dd>{c.explanation}</dd>
          {run && (
            <>
              <dt>Checker said</dt>
              <dd>
                {run.refused ? <>Refused as input: {run.reason}</> : run.label && (
                  <><TrustLabel label={run.label} size="sm" /> {run.reason}</>
                )}
              </dd>
              {!!run.checks?.length && (
                <>
                  <dt>Fields</dt>
                  <dd>
                    <ul className="lab-checks">
                      {run.checks.map((f) => (
                        <li key={f.field} data-status={f.status}>
                          <b>{f.field}</b>: {f.status === "match" ? "matches" : f.status === "mismatch" ? "does not match" : "not given"}
                          {f.detail && <> — {f.detail}</>}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
              {run.retraction?.detail && <><dt>Retraction</dt><dd>{run.retraction.detail}</dd></>}
              <dt>Asked</dt>
              <dd>
                {run.sources_checked?.join(" · ") || (run.refused ? "none (refused before searching)" : "none")}
                {!!run.unavailable?.length && <> · did not answer: {run.unavailable.join(", ")}</>}
              </dd>
              <dt>Score</dt><dd>{run.evaluation.text}{run.evaluation.limited_coverage && " (coverage gap)"}</dd>
            </>
          )}
          {s.error && <><dt>Error</dt><dd>{s.error}</dd></>}
          {c.provenance.length > 0 && (
            <>
              <dt>Provenance</dt>
              <dd>
                {c.provenance.map((p) => (
                  <span key={p.doi + p.url} className="lab-prov">
                    {p.registry}: <a href={`https://doi.org/${p.doi}`} target="_blank" rel="noreferrer">{p.doi}</a>
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      </details>
    </li>
  );
}

