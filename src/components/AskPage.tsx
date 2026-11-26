// The Ask page: one research question through the nine agents, drawn as a live flow.
// Square = plain code, round = AI, dashed = you (a human checkpoint the run stops at).
import { Bot, Check, CircleAlert, Copy, Download, FileText, Loader2, Lock, Play, RotateCcw, Sparkles, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { runExport } from "../lib/exportActions";
import {
  approveTerms, bindProject, keepSources, resetAsk, setTerms, STAGES, startAsk, toggleCandidate, useAsk,
  type AskState, type Requirements, type StageId, type Status,
} from "../lib/askFlow";
import type { Project, Reference } from "../types";
import { AI_LEVELS, ClaimResult } from "./AiAgents";
import { TrustLabel } from "./TrustLabel";

interface Props {
  project: Project;
  library: Reference[];
  compact: boolean;
  onAdded: () => void;
  onGo: (page: "project" | "statement" | "list" | "library") => void;
}

const STATUS_TEXT: Record<Status, string> = {
  idle: "Waiting", running: "Working…", waiting: "Your turn", done: "Done", skipped: "Skipped", locked: "Locked", error: "Problem",
};

// ---------------------------------------------------------------- the live flow diagram
const short = (t: string) => (t.length > 24 ? `${t.slice(0, 23).trimEnd()}…` : t);
function nodeIcon(kind: string, status: Status) {
  if (status === "running") return <Loader2 size={15} className="spin" aria-hidden="true" />;
  if (status === "done") return <Check size={15} aria-hidden="true" />;
  if (status === "locked") return <Lock size={14} aria-hidden="true" />;
  if (status === "error") return <CircleAlert size={15} aria-hidden="true" />;
  return kind === "you" ? <UserRound size={15} aria-hidden="true" /> : kind === "ai" ? <Sparkles size={14} aria-hidden="true" /> : <Bot size={14} aria-hidden="true" />;
}

function FlowDiagram({ s, compact, onPick }: { s: AskState; compact: boolean; onPick: (id: StageId) => void }) {
  const edgeState = (a: StageId, b: StageId) => {
    const sa = s.status[a], sb = s.status[b];
    if (sb === "running" || sb === "waiting") return "active";
    return ["done", "skipped", "locked"].includes(sa) && sb !== "idle" ? "done" : "idle";
  };
  if (compact) {
    return (
      <ol className="flow-v" aria-label="Live research flow">
        {STAGES.map((st, i) => (
          <li key={st.id} data-kind={st.kind} data-status={s.status[st.id]} data-edge={i ? edgeState(STAGES[i - 1]!.id, st.id) : undefined}>
            <button type="button" onClick={() => onPick(st.id)}>
              <span className="flow-ic">{nodeIcon(st.kind, s.status[st.id])}</span>
              <span className="flow-tx"><b>{st.name}</b><small>{s.note[st.id] || st.does}</small></span>
              <span className="flow-st">{STATUS_TEXT[s.status[st.id]]}</span>
            </button>
          </li>
        ))}
      </ol>
    );
  }
  // desktop: two rows of six; row 2 continues left to right after the return line
  const W = 1200, X = (i: number) => 100 + (i % 6) * 200, Y = (i: number) => (i < 6 ? 78 : 240);
  return (
    <svg className="flow-svg" viewBox={`0 0 ${W} 320`} role="group" aria-label="Live research flow">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="flow-arrow" />
        </marker>
      </defs>
      {STAGES.slice(1).map((st, j) => {
        const i = j + 1, prev = STAGES[i - 1]!;
        const e = edgeState(prev.id, st.id);
        const d = i === 6
          ? `M ${X(5)} ${Y(5) + 44} V 159 H ${X(6)} V ${Y(6) - 46}`
          : `M ${X(i - 1) + 82} ${Y(i)} H ${X(i) - 84}`;
        return <path key={st.id} d={d} className={`flow-edge edge-${e}`} markerEnd="url(#arr)" />;
      })}
      {STAGES.map((st, i) => {
        const status = s.status[st.id];
        const x = X(i) - 80, y = Y(i) - 42;
        const rx = st.kind === "ai" ? 42 : st.kind === "you" ? 14 : 6;
        return (
          <g key={st.id} className={`flow-node kind-${st.kind} st-${status}`} transform={`translate(${x} ${y})`}
            role="button" tabIndex={0} aria-label={`${st.name}: ${STATUS_TEXT[status]}. ${s.note[st.id] || st.does}`}
            onClick={() => onPick(st.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick(st.id)}>
            {status === "running" && <rect className="flow-pulse" x={-5} y={-5} width={170} height={94} rx={rx + 4} />}
            <rect width={160} height={84} rx={rx} />
            <text x={80} y={30} textAnchor="middle" className="flow-name">{st.name}</text>
            <text x={80} y={49} textAnchor="middle" className="flow-sub">{st.kind === "ai" ? `AI · level ${st.minLevel}` : st.kind === "code" ? "plain code" : "human checkpoint"}</text>
            <title>{`${st.name} · ${STATUS_TEXT[status]}${s.note[st.id] ? ` · ${s.note[st.id]}` : ""}`}</title>
            <text x={80} y={68} textAnchor="middle" className="flow-note">{short(status === "waiting" ? "Your turn" : s.note[st.id] || STATUS_TEXT[status])}</text>
            <circle cx={146} cy={14} r={6} className="flow-dot" />
          </g>
        );
      })}
      <text x={20} y={312} className="flow-legend">■ plain code   ● AI (labelled AI suggestion)   ▢ you: the run stops until you act</text>
    </svg>
  );
}

// ---------------------------------------------------------------- the page
export function AskPage({ project, library, compact, onAdded, onGo }: Props) {
  const s = useAsk();
  const lib = useRef(library);
  lib.current = library;
  useEffect(() => bindProject(project.id), [project.id]);
  const [req, setReq] = useState<Requirements>({
    question: project.question || "", count: 5, fromYear: null, toYear: null, keywords: "", journalOnly: true, claims: [],
  });
  const [claimsText, setClaimsText] = useState("");
  const [exportMsg, setExportMsg] = useState("");
  const level = project.ai_level ?? 3;
  const started = s.status.ask !== "idle";
  const kept = s.candidates.filter((c) => c.selected && c.rid);
  const keptRefs = useMemo(() => library.filter((r) => kept.some((c) => c.rid === r.id)), [library, kept]);
  const busy = Object.values(s.status).includes("running");
  const pick = (id: StageId) => document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  function start(e: React.FormEvent) {
    e.preventDefault();
    const claims = claimsText.split(/\n+/).map((c) => c.trim()).filter((c) => c.length >= 8).slice(0, 3);
    startAsk(project.id, level, { ...req, question: req.question.trim(), claims });
  }

  async function exportKept(format: "apa-copy" | "apa-docx") {
    const r = await runExport(project.id, keptRefs, format);
    setExportMsg(r.message);
  }

  return (
    <div className="page ask">
      <header className="ask-hero">
        <div>
          <p className="ask-kicker">Research assistant</p>
          <h1>Ask Paper Trail</h1>
          <p className="hint">Nine agents work through your question in order. Plain code finds and checks every source; AI only suggests,
            reads and challenges, and the run stops for you at each checkpoint. Nothing enters your library until you add it.</p>
        </div>
        <div className="ask-level">
          <span>AI level</span>
          <b>{level} · {AI_LEVELS[level]?.name}</b>
          <button type="button" className="btn-ghost btn-sm" onClick={() => onGo("project")}>Change</button>
        </div>
      </header>

      <section className="panel flow-panel" aria-live="polite">
        <div className="flow-head">
          <h2 className="panel-title">Live flow</h2>
          {started && <button type="button" className="btn-ghost btn-sm" onClick={resetAsk} disabled={busy}><RotateCcw size={14} aria-hidden="true" /> New ask</button>}
        </div>
        <FlowDiagram s={s} compact={compact} onPick={pick} />
        {s.log.length > 0 && (
          <details className="flow-log" open={!compact}>
            <summary>Live log · {s.log.length} events</summary>
            <ol>{s.log.slice().reverse().slice(0, 40).map((l, i) => <li key={i}><time>{l.at}</time> <b>{STAGES.find((x) => x.id === l.stage)?.name}</b> {l.text}</li>)}</ol>
          </details>
        )}
      </section>

      {/* 1. You ask */}
      <section className="panel ask-step" id="step-ask" data-status={s.status.ask}>
        <StepHead n={1} id="ask" s={s} title="Your question and requirements" />
        {!started ? (
          <form className="form ask-form" onSubmit={start}>
            <label>Research question
              <textarea rows={3} required minLength={10} maxLength={1500} value={req.question}
                onChange={(e) => setReq({ ...req, question: e.target.value })} placeholder="e.g. Does working from home change employee performance?" />
            </label>
            <div className="ask-grid">
              <label>Sources you need
                <select value={req.count} onChange={(e) => setReq({ ...req, count: Number(e.target.value) })}>
                  {[3, 5, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label>Published from
                <input type="number" min={1900} max={2100} placeholder="any" value={req.fromYear ?? ""}
                  onChange={(e) => setReq({ ...req, fromYear: e.target.value ? Number(e.target.value) : null })} />
              </label>
              <label>Published to
                <input type="number" min={1900} max={2100} placeholder="now" value={req.toYear ?? ""}
                  onChange={(e) => setReq({ ...req, toYear: e.target.value ? Number(e.target.value) : null })} />
              </label>
              <label>Must-include keywords <span className="optional">(optional)</span>
                <input maxLength={200} value={req.keywords} placeholder="e.g. remote work" onChange={(e) => setReq({ ...req, keywords: e.target.value })} />
              </label>
            </div>
            <label className="menu-check"><input type="checkbox" checked={req.journalOnly} onChange={(e) => setReq({ ...req, journalOnly: e.target.checked })} /> Journal articles only</label>
            <label>Sentences from your draft to test <span className="optional">(optional, one per line, up to 3)</span>
              <textarea rows={3} maxLength={1800} value={claimsText} onChange={(e) => setClaimsText(e.target.value)}
                placeholder={"e.g. Home working lifted employee performance by 31%."} />
            </label>
            <p className="hint small">At level {level}: {STAGES.filter((x) => x.kind === "ai").map((x) => `${x.name} ${level >= (x.minLevel ?? 0) ? "on" : "locked"}`).join(" · ")}.</p>
            <div className="actions"><button className="btn-primary"><Play size={16} aria-hidden="true" /> Start the research flow</button></div>
          </form>
        ) : (
          <dl className="ask-req">
            <dt>Question</dt><dd>{s.req?.question}</dd>
            <dt>Requirements</dt><dd>{s.req?.count} sources{s.req?.fromYear || s.req?.toYear ? ` · ${s.req?.fromYear ?? "any"}–${s.req?.toYear ?? "now"}` : ""}{s.req?.keywords ? ` · must include “${s.req.keywords}”` : ""}{s.req?.journalOnly ? " · journal articles" : ""}</dd>
            {!!s.req?.claims.length && <><dt>Claims to test</dt><dd>{s.req.claims.map((c) => <q key={c}>{c}</q>)}</dd></>}
          </dl>
        )}
      </section>

      {/* 2. Planner + checkpoint 1 */}
      {started && (
        <section className="panel ask-step" id="step-planner" data-status={s.status.gate1}>
          <StepHead n={2} id="planner" s={s} title="Search terms" />
          <span id="step-gate1" />
          {s.status.planner === "locked" ? <p className="hint small"><Lock size={13} /> Planner is locked at level {level}; these terms come from your own words.</p>
            : s.plannerModel && <p className="ai-tag"><TrustLabel label="ai_suggestion" size="sm" /> Planner · {s.plannerModel}</p>}
          {s.status.planner === "running" && <p className="hint">Asking the AI…</p>}
          {s.terms.length > 0 && (
            <ul className="ask-terms">
              {s.terms.map((t, i) => (
                <li key={i}>
                  <input type="checkbox" checked={t.on} disabled={s.status.gate1 !== "waiting"} aria-label={`Use ${t.query}`}
                    onChange={() => setTerms(s.terms.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} />
                  <input className="ask-term" value={t.query} disabled={s.status.gate1 !== "waiting"} maxLength={100} aria-label="Search term"
                    onChange={(e) => setTerms(s.terms.map((x, j) => (j === i ? { ...x, query: e.target.value } : x)))} />
                  <span className="hint small">{t.mine ? "yours" : t.why}</span>
                </li>
              ))}
            </ul>
          )}
          {s.status.gate1 === "waiting" && (
            <div className="actions gate">
              <span className="gate-tag"><UserRound size={14} aria-hidden="true" /> Checkpoint: you decide</span>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setTerms([...s.terms, { query: "", why: "", on: true, mine: true }])}>Add a term</button>
              <button type="button" className="btn-primary" disabled={!s.terms.some((t) => t.on && t.query.trim())} onClick={() => approveTerms(project.id)}>
                Approve {s.terms.filter((t) => t.on && t.query.trim()).length} terms and search
              </button>
            </div>
          )}
        </section>
      )}

      {/* 3–5. Scout, Checker, Analyst + checkpoint 2 */}
      {["running", "done", "error"].includes(s.status.scout) && (
        <section className="panel ask-step" id="step-scout" data-status={s.status.gate2}>
          <StepHead n={3} id="analyst" s={s} title="Sources found, checked and ranked" />
          <span id="step-checker" /><span id="step-analyst" /><span id="step-gate2" />
          <p className="hint small">Scout: {s.note.scout ?? "…"} · Checker: {s.note.checker ?? "…"} · Analyst: {s.note.analyst ?? "…"}</p>
          {s.analystMethod && <p className="hint small">How the Analyst ranks: {s.analystMethod}</p>}
          <ul className="ask-cands">
            {s.candidates.map((c) => {
              const a = c.analysis;
              const ret = c.check?.retraction?.status;
              const usable = c.check?.label === "verified" && ret !== "retracted" && !!a;
              const locked = s.status.gate2 !== "waiting" || !usable;
              return (
                <li key={c.doi} className="ask-cand" data-selected={c.selected} data-usable={usable}>
                  <input type="checkbox" checked={c.selected} disabled={locked} onChange={() => toggleCandidate(c.doi)} aria-label={`Keep ${c.title}`} />
                  <div className="ask-cand-main">
                    <div className="ask-cand-top">
                      {c.check ? <TrustLabel label={c.check.label} size="sm" /> : <span className="hint small">checking…</span>}
                      {ret === "retracted" && <span className="chip chip-red">Retracted — kept out</span>}
                      {a && <span className="ask-rel" title="Relevance to your question (TF-IDF)"><i style={{ width: `${a.relevance_pct}%` }} />{a.relevance_pct}%</span>}
                      {a?.design && <span className="chip chip-grey">{a.design}</span>}
                      {c.check?.in_list && <span className="chip chip-grey">In your library</span>}
                    </div>
                    <b className="ask-cand-title">{c.title}</b>
                    <span className="hint small">{c.authors.slice(0, 3).join(", ")}{c.authors.length > 3 ? " et al." : ""} · {c.year ?? "n.d."} · {c.container}{a?.cited_by != null ? ` · cited ${a.cited_by.toLocaleString()}×` : ""}</span>
                    {a?.sections.findings[0] && <p className="ask-finding"><span>Finding, in the paper’s words:</span> “{a.sections.findings[0]}”</p>}
                    {c.add === "added" && <span className="pill-done">✓ Added by you</span>}
                    {c.add === "exists" && <span className="pill-done">✓ Already in your library</span>}
                    {c.addError && <span className="error small">{c.addError}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
          {s.status.gate2 === "waiting" && s.candidates.length > 0 && (
            <div className="actions gate">
              <span className="gate-tag"><UserRound size={14} aria-hidden="true" /> Checkpoint: you choose</span>
              <span className="hint small">The Analyst ticked the top {s.req?.count}. Change any; nothing is added until you click.</span>
              <button type="button" className="btn-primary" disabled={!s.candidates.some((c) => c.selected)}
                onClick={() => keepSources(project.id, () => lib.current, onAdded)}>
                Add {s.candidates.filter((c) => c.selected).length} to my library and continue
              </button>
            </div>
          )}
        </section>
      )}

      {/* 6–7. Reader + Quote guard */}
      {s.status.gate2 === "done" && (
        <section className="panel ask-step" id="step-reader" data-status={s.status.reader}>
          <StepHead n={4} id="reader" s={s} title="What your sources say" />
          <span id="step-guard" />
          {s.status.reader === "locked" ? <p className="hint small"><Lock size={13} /> Reader is locked at level {level}. The Analyst’s sentence sorting (code) is shown instead.</p>
            : <p className="hint small">Quote guard: {s.note.guard ?? "…"} — only passages found word for word in the abstract are shown.</p>}
          <div className="ask-reads">
            {kept.map((c) => {
              const sec = c.reading?.sections ?? c.analysis?.sections;
              return (
                <article key={c.doi} className="ask-read">
                  <header>
                    {c.reading ? <TrustLabel label="ai_suggestion" size="sm" /> : <span className="chip chip-grey">Analyst · code</span>}
                    <b>{c.title}</b>
                  </header>
                  {sec ? (["aim", "method", "findings", "limits"] as const).map((k) => sec[k].length > 0 && (
                    <div key={k} className="ask-sec"><span>{k}</span><div>{sec[k].map((q) => <q key={q}>{q}</q>)}</div></div>
                  )) : <p className="hint small">No abstract on record.</p>}
                  {c.readError && <p className="hint small">Reader: {c.readError}</p>}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* 8. Challenger */}
      {s.status.gate2 === "done" && (s.claims.length > 0 || s.status.challenger === "running") && (
        <section className="panel ask-step" id="step-challenger" data-status={s.status.challenger}>
          <StepHead n={5} id="challenger" s={s} title="Your claims, challenged" />
          {s.claims.map((c, i) => (
            <div key={i} className="ask-claim">
              <p><b>Your sentence:</b> {c.claim}</p>
              <p className="hint small">Tested against: {s.candidates.find((x) => x.doi === c.doi)?.title ?? c.doi}</p>
              {c.result && <ClaimResult res={c.result} />}
              {c.error && <p className="error small">{c.error}</p>}
            </div>
          ))}
        </section>
      )}

      {/* 9. Reviewer */}
      {s.review.length > 0 && (
        <section className="panel ask-step" id="step-reviewer" data-status={s.status.reviewer}>
          <StepHead n={6} id="reviewer" s={s} title="What a marker could question" />
          <ul className="ask-review">
            {s.review.map((r, i) => <li key={i} data-level={r.level}><span aria-hidden="true">{r.level === "ok" ? "✓" : r.level === "fix" ? "✕" : "!"}</span>{r.text}</li>)}
          </ul>
          <p className="hint small">Plain-code checks over your whole library and this run. The Reviewer approves nothing; you decide.</p>
        </section>
      )}

      {/* 10. Clerk */}
      {s.status.clerk === "done" && (
        <section className="panel ask-step" id="step-clerk" data-status="done">
          <StepHead n={7} id="clerk" s={s} title="Cite and declare" />
          <div className="actions">
            <button type="button" className="btn-primary" onClick={() => exportKept("apa-copy")}><Copy size={15} aria-hidden="true" /> Copy APA 7 list ({keptRefs.length})</button>
            <button type="button" className="btn-secondary" onClick={() => exportKept("apa-docx")}><Download size={15} aria-hidden="true" /> Download Word (.docx)</button>
            <button type="button" className="btn-secondary" onClick={() => onGo("statement")}><FileText size={15} aria-hidden="true" /> Open the AI-use statement</button>
            <button type="button" className="btn-ghost" onClick={() => onGo("library")}>Open the library</button>
          </div>
          {exportMsg && <p className="notice notice-ok" role="status">{exportMsg}</p>}
        </section>
      )}
      {!started && <p className="hint small ask-foot">Each agent’s output is logged, so the AI-use statement can say exactly what was done.</p>}
    </div>
  );
}

function StepHead({ n, id, s, title }: { n: number; id: StageId; s: AskState; title: string }) {
  const st = STAGES.find((x) => x.id === id)!;
  return (
    <div className="ask-step-head">
      <span className="ask-n">{n}</span>
      <h2 className="panel-title">{title}</h2>
      <span className={`ask-badge kind-${st.kind}`}>{st.name}</span>
      <span className={`ask-st st-${s.status[id]}`}>{STATUS_TEXT[s.status[id]]}</span>
    </div>
  );
}
