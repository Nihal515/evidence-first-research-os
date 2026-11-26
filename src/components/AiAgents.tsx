// The three AI agents in the workspace, plus the AI dial. Every AI output carries the
// "AI suggestion" label; what code checked afterwards is shown next to it.
import { Bot, CheckCircle2, Lock, ShieldAlert, Sparkles, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { AiClaimCheck, AiSearchTerms, Project, Reference } from "../types";
import { TrustLabel } from "./TrustLabel";

export const AI_LEVELS = [
  { level: 0, name: "No AI", means: "Search, checking and citing only. Every AI agent is locked." },
  { level: 1, name: "Find and check", means: "AI may suggest search terms (Planner)." },
  { level: 2, name: "Read and summarise", means: "AI may also point at passages in sources you kept (Reader)." },
  { level: 3, name: "Challenge my draft", means: "AI may also test your sentences against a source (Challenger). It never writes your assignment." },
];

const AGENTS = [
  { name: "Planner", kind: "ai", min: 1, does: "Suggests search terms from your question." },
  { name: "Scout", kind: "code", min: 0, does: "Searches Crossref and OpenAlex." },
  { name: "Checker", kind: "code", min: 0, does: "Compares title, authors, year and DOI; issues the trust label." },
  { name: "Reader", kind: "ai", min: 2, does: "Points at aim, method, findings and limits in an abstract." },
  { name: "Quote guard", kind: "code", min: 0, does: "Throws away any AI quote that is not word for word in the source." },
  { name: "Challenger", kind: "ai", min: 3, does: "Says whether a source supports your sentence; code checks its numbers." },
  { name: "Clerk", kind: "code", min: 0, does: "Formats APA 7 and writes the AI-use statement from the log." },
];

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "The AI could not answer. Nothing was changed.");

function AiTag({ agent, model }: { agent: string; model?: string }) {
  return (
    <span className="ai-tag">
      <TrustLabel label="ai_suggestion" size="sm" />
      <span>{agent}{model ? ` · ${model}` : ""}</span>
    </span>
  );
}

function Locked({ agent, need, level }: { agent: string; need: number; level: number }) {
  return (
    <p className="hint small ai-locked">
      <Lock size={13} aria-hidden="true" /> {agent} is locked: this project’s AI level is {level} ({AI_LEVELS[level]?.name}).
      It needs level {need}. Change it on the Project page if your assessment allows.
    </p>
  );
}

// ---------------------------------------------------------------- Planner (in Add → Search)
export function PlannerChips({ projectId, aiLevel, onPick }: { projectId: string; aiLevel: number; onPick: (q: string) => void }) {
  const [res, setRes] = useState<AiSearchTerms | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  if (aiLevel < 1) return <Locked agent="Planner" need={1} level={aiLevel} />;

  async function suggest() {
    setBusy(true);
    setError("");
    try {
      setRes(await api.aiSearchTerms(projectId, question.trim()));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ai-box">
      <div className="ai-row">
        <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1500}
          placeholder="Your research question (blank = the project’s question)" aria-label="Research question for AI search terms" />
        <button type="button" className="btn-secondary btn-sm" onClick={suggest} disabled={busy}>
          <Sparkles size={14} aria-hidden="true" /> {busy ? "Thinking…" : "Suggest search terms with AI"}
        </button>
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
      {res && (
        <>
          <AiTag agent="Planner" model={res.model} />
          <ul className="ai-chips" aria-label="AI-suggested search terms">
            {res.queries.map((q) => (
              <li key={q.query}>
                <button type="button" className="ai-chip" onClick={() => onPick(q.query)} title={q.why}>{q.query}</button>
                <span className="hint small">{q.why}</span>
              </li>
            ))}
          </ul>
          <p className="hint small">Search terms only. Clicking one searches Crossref and OpenAlex, so every result is a real registry record with its own trust label.</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Reader and Challenger (in Details)
const SECTION_NAME = { aim: "Aim", method: "Method", findings: "Findings", limits: "Limits" } as const;

const VERDICT: Record<AiClaimCheck["verdict"], { text: string; cls: string; icon: typeof CheckCircle2 }> = {
  supported: { text: "Supported by the abstract", cls: "ai-ok", icon: CheckCircle2 },
  contradicted: { text: "Not supported as written", cls: "ai-bad", icon: XCircle },
  not_addressed: { text: "The abstract does not say", cls: "ai-warn", icon: ShieldAlert },
  discarded: { text: "AI answer discarded", cls: "ai-warn", icon: ShieldAlert },
};

export function AiSourceTools({ projectId, reference: r, aiLevel, onChanged }:
  { projectId: string; reference: Reference; aiLevel: number; onChanged: (r?: Reference) => void }) {
  const [busy, setBusy] = useState<"read" | "claim" | null>(null);
  const [error, setError] = useState("");
  const [claim, setClaim] = useState("");
  const [result, setResult] = useState<AiClaimCheck | null>(null);
  useEffect(() => {
    setError("");
    setResult(null);
    setClaim("");
  }, [r.id]);

  if (r.label !== "verified") {
    return <p className="hint small">AI reads only Verified sources, so it never works from a reference that may not exist.</p>;
  }
  const reading = r.ai_reading;

  async function read(refresh: boolean) {
    setBusy("read");
    setError("");
    try {
      onChanged(await api.aiRead(projectId, r.id, refresh));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }
  async function challenge(e: React.FormEvent) {
    e.preventDefault();
    if (claim.trim().length < 8) return;
    setBusy("claim");
    setError("");
    setResult(null);
    try {
      setResult(await api.aiClaim(projectId, r.id, claim.trim()));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ai-tools">
      {/* Reader */}
      <div className="ai-block">
        <p className="ai-head"><Bot size={15} aria-hidden="true" /> <b>Reader</b> · aim, method, findings and limits, quoted from the abstract</p>
        {aiLevel < 2 ? <Locked agent="Reader" need={2} level={aiLevel} /> : (
          <>
            {reading ? (
              <>
                <AiTag agent="Reader" model={reading.model} />
                <dl className="ai-reading">
                  {(["aim", "method", "findings", "limits"] as const).map((k) => (
                    <div key={k}>
                      <dt>{SECTION_NAME[k]}</dt>
                      <dd>
                        {reading.sections[k].length ? reading.sections[k].map((q) => <q key={q}>{q}</q>)
                          : <span className="hint small">The abstract does not say.</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="hint small ai-guard">
                  <CheckCircle2 size={13} aria-hidden="true" /> Quote guard (code): {reading.kept} quote{reading.kept === 1 ? "" : "s"} found word for word in the abstract
                  {reading.dropped ? `; ${reading.dropped} not found and discarded` : ""}. Abstract only, not the full paper.
                </p>
                <button type="button" className="btn-ghost btn-sm" onClick={() => read(true)} disabled={busy === "read"}>
                  {busy === "read" ? "Reading…" : "Read again"}
                </button>
              </>
            ) : (
              <button type="button" className="btn-secondary btn-sm" onClick={() => read(false)} disabled={busy === "read"}>
                <Sparkles size={14} aria-hidden="true" /> {busy === "read" ? "Reading the abstract…" : "Read the abstract with AI"}
              </button>
            )}
          </>
        )}
      </div>

      {/* Challenger */}
      <div className="ai-block">
        <p className="ai-head"><Bot size={15} aria-hidden="true" /> <b>Challenger</b> · does this source support your sentence?</p>
        {aiLevel < 3 ? <Locked agent="Challenger" need={3} level={aiLevel} /> : (
          <form onSubmit={challenge} className="ai-claim">
            <label htmlFor={`claim-${r.id}`} className="field-label">Your sentence</label>
            <textarea id={`claim-${r.id}`} rows={2} value={claim} maxLength={1000} onChange={(e) => setClaim(e.target.value)}
              placeholder="e.g. Home working lifted performance by 31%." />
            <div className="actions">
              <button className="btn-secondary btn-sm" disabled={busy === "claim" || claim.trim().length < 8}>
                <Sparkles size={14} aria-hidden="true" /> {busy === "claim" ? "Checking…" : "Check my sentence"}
              </button>
            </div>
            {result && <ClaimResult res={result} />}
          </form>
        )}
      </div>
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}

export function ClaimResult({ res }: { res: AiClaimCheck }) {
  const v = VERDICT[res.verdict];
  const Icon = v.icon;
  return (
    <div className={`ai-verdict ${v.cls}`} role="status">
      <AiTag agent="Challenger" model={res.model} />
      <p className="ai-verdict-head"><Icon size={16} aria-hidden="true" /> <b>{v.text}</b></p>
      {res.quote && <p className="ai-quote"><q>{res.quote}</q></p>}
      {res.explanation && res.verdict !== "discarded" && <p className="hint small">AI: {res.explanation}</p>}
      <ul className="ai-guards">
        {res.verdict !== "not_addressed" && (
          <li data-ok={res.quote_ok}>{res.quote_ok ? "✓ Quote found word for word in the abstract (code)" : "✕ Quote not in the abstract (code)"}</li>
        )}
        {res.numbers && <li data-ok={res.numbers.ok}>{res.numbers.ok ? "✓ " : "✕ "}{res.numbers.text}</li>}
        {res.guard && <li data-ok="false">{res.guard}</li>}
      </ul>
      <p className="hint small">Checked against the abstract only. Read the paper before you rely on it.</p>
    </div>
  );
}

// ---------------------------------------------------------------- the AI dial (Project page)
export function AiDial({ project, onProject }: { project: Project; onProject: (p: Project) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [model, setModel] = useState("");
  useEffect(() => {
    api.aiStatus().then((s) => { setConfigured(s.configured); setModel(s.model); }).catch(() => setConfigured(null));
  }, []);
  const level = project.ai_level ?? 3;

  async function set(l: number) {
    if (l === level) return;
    setBusy(true);
    setError("");
    try {
      onProject(await api.setAiLevel(project.id, l));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel ai-dial-panel">
      <h3><Bot size={18} aria-hidden="true" /> AI level for this project</h3>
      <p className="hint">Set it to your assessment’s AI rule. Agents above the level go dark here and are refused at the server.</p>
      <div className="ai-dial" role="radiogroup" aria-label="AI level">
        {AI_LEVELS.map((l) => (
          <button key={l.level} type="button" role="radio" aria-checked={level === l.level} disabled={busy}
            className={level === l.level ? "ai-dial-on" : ""} onClick={() => set(l.level)}>
            <b>{l.level}</b><span>{l.name}</span>
          </button>
        ))}
      </div>
      <p className="hint small">{AI_LEVELS[level]?.means}</p>
      <ul className="ai-agents">
        {AGENTS.map((a) => {
          const on = a.kind === "code" || level >= a.min;
          return (
            <li key={a.name} data-kind={a.kind} data-on={on}>
              <i aria-hidden="true" /> <b>{a.name}</b> <span className="hint small">{a.kind === "ai" ? "AI" : "code"} · {a.does}{!on ? " (locked)" : ""}</span>
            </li>
          );
        })}
      </ul>
      {configured === false && <p className="notice notice-warn">AI is not set up on this server yet, so the AI agents cannot run.</p>}
      {configured && model && <p className="hint small">AI model: {model}. AI never decides whether a reference is real and never adds anything to your library.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </section>
  );
}
