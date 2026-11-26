// The Ask workflow engine. One research question runs through the nine agents in order,
// stopping at each human checkpoint:
//   You ask → Planner (AI) → You approve terms → Scout → Checker → Analyst → You choose sources
//   → Reader (AI) → Quote guard → Challenger (AI) → Reviewer → Clerk
// The state lives outside React, so a run keeps going while the person moves between pages.
// AI never adds a source: only the "Add to library" click at the second checkpoint does.
import { useSyncExternalStore } from "react";
import { api, ApiError } from "../api";
import type { AiClaimCheck, AiReading, AnalysedSource, CheckResult, Reference, Retraction, SearchResult } from "../types";

export type StageId = "ask" | "planner" | "gate1" | "scout" | "checker" | "analyst" | "gate2" | "reader" | "guard" | "challenger" | "reviewer" | "clerk";
export type Status = "idle" | "running" | "waiting" | "done" | "skipped" | "locked" | "error";
export type Kind = "you" | "ai" | "code";

export const STAGES: { id: StageId; name: string; kind: Kind; minLevel?: number; does: string }[] = [
  { id: "ask", name: "You ask", kind: "you", does: "Question and requirements" },
  { id: "planner", name: "Planner", kind: "ai", minLevel: 1, does: "Turns it into search terms" },
  { id: "gate1", name: "You approve", kind: "you", does: "The search terms" },
  { id: "scout", name: "Scout", kind: "code", does: "Searches Crossref and OpenAlex" },
  { id: "checker", name: "Checker", kind: "code", does: "Verifies each record, finds retractions" },
  { id: "analyst", name: "Analyst", kind: "code", does: "Ranks by relevance, sorts sentences" },
  { id: "gate2", name: "You choose", kind: "you", does: "The sources to keep" },
  { id: "reader", name: "Reader", kind: "ai", minLevel: 2, does: "Quotes aim, method, findings, limits" },
  { id: "guard", name: "Quote guard", kind: "code", does: "Keeps only word-for-word quotes" },
  { id: "challenger", name: "Challenger", kind: "ai", minLevel: 3, does: "Tests your claims against sources" },
  { id: "reviewer", name: "Reviewer", kind: "code", does: "Lists what a marker could question" },
  { id: "clerk", name: "Clerk", kind: "code", does: "APA 7 list and AI-use statement" },
];

export interface Requirements {
  question: string;
  count: number;          // sources wanted
  fromYear: number | null;
  toYear: number | null;
  keywords: string;
  journalOnly: boolean;
  claims: string[];       // sentences from the draft to test (max 3)
}

export interface Term { query: string; why: string; on: boolean; mine: boolean }

export interface Candidate {
  doi: string;
  title: string;
  authors: string[];
  year: number | null;
  container: string;
  type: string;
  queries: string[];
  check?: CheckResult & { retraction?: Retraction | null };
  analysis?: AnalysedSource;
  selected: boolean;
  rid?: string;
  add?: "adding" | "added" | "exists" | "error";
  addError?: string;
  reading?: AiReading | null;
  readError?: string;
}

export interface ClaimRun { claim: string; doi?: string; rid?: string; result?: AiClaimCheck; error?: string }
export interface ReviewItem { level: "ok" | "warn" | "fix"; text: string }
export interface LogLine { at: string; stage: StageId; text: string }

export interface AskState {
  projectId: string | null;
  status: Record<StageId, Status>;
  note: Partial<Record<StageId, string>>;
  req: Requirements | null;
  aiLevel: number;
  terms: Term[];
  plannerModel: string;
  candidates: Candidate[];
  analystMethod: string;
  claimBest: { claim: string; best: { doi: string; score: number }[] }[];
  claims: ClaimRun[];
  review: ReviewItem[];
  log: LogLine[];
  startedAt: string | null;
  finishedAt: string | null;
}

const idle = (): Record<StageId, Status> => Object.fromEntries(STAGES.map((s) => [s.id, "idle"])) as Record<StageId, Status>;
const blank = (projectId: string | null = null): AskState => ({
  projectId, status: idle(), note: {}, req: null, aiLevel: 3, terms: [], plannerModel: "", candidates: [], analystMethod: "",
  claimBest: [], claims: [], review: [], log: [], startedAt: null, finishedAt: null,
});

// ---------------------------------------------------------------- a tiny external store
let state: AskState = blank();
const listeners = new Set<() => void>();
function set(patch: Partial<AskState> | ((s: AskState) => Partial<AskState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function useAsk(): AskState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
export const getAsk = () => state;

function stage(id: StageId, status: Status, note?: string) {
  set((s) => ({ status: { ...s.status, [id]: status }, note: note === undefined ? s.note : { ...s.note, [id]: note } }));
}
function log(stageId: StageId, text: string) {
  set((s) => ({ log: [...s.log, { at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), stage: stageId, text }].slice(-80) }));
}
function patchCandidate(doi: string, patch: Partial<Candidate>) {
  set((s) => ({ candidates: s.candidates.map((c) => (c.doi === doi ? { ...c, ...patch } : c)) }));
}
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A new project gets a fresh workflow. */
export function bindProject(projectId: string) {
  if (state.projectId !== projectId) set(blank(projectId));
}
export function resetAsk() {
  set(blank(state.projectId));
}

// ---------------------------------------------------------------- 1. You ask → Planner → checkpoint 1
function fallbackTerms(r: Requirements): Term[] {
  const words = r.question.replace(/[?.,;:!"“”]/g, " ").split(/\s+/)
    .filter((w) => w.length > 3 && !/^(does|what|which|whether|how|with|from|that|this|there|their|about|change|changes)$/i.test(w));
  const terms: Term[] = [{ query: words.slice(0, 6).join(" ") || r.question.slice(0, 80), why: "Key words from your question", on: true, mine: true }];
  if (r.keywords.trim()) terms.push({ query: r.keywords.trim(), why: "Your must-include keywords", on: true, mine: true });
  return terms;
}

export async function startAsk(projectId: string, aiLevel: number, req: Requirements) {
  set({ ...blank(projectId), req, aiLevel, startedAt: new Date().toISOString() });
  stage("ask", "done", `${req.count} sources${req.fromYear || req.toYear ? `, ${req.fromYear ?? "any"}–${req.toYear ?? "now"}` : ""}${req.claims.length ? `, ${req.claims.length} claim${req.claims.length === 1 ? "" : "s"}` : ""}`);
  log("ask", `Asked: “${req.question.slice(0, 120)}”`);
  api.event(projectId, "RESEARCH_ASKED", { question: req.question.slice(0, 300), count: req.count, from: req.fromYear, to: req.toYear,
    journal_only: req.journalOnly, claims: req.claims.length });
  for (const s of STAGES) if (s.minLevel && aiLevel < s.minLevel) stage(s.id, "locked", `Needs AI level ${s.minLevel}`);

  if (aiLevel >= 1) {
    stage("planner", "running", "Asking the AI for search terms…");
    log("planner", "Planner (AI) is turning the question into search terms");
    try {
      const q = req.keywords.trim() ? `${req.question}\nMust include: ${req.keywords.trim()}` : req.question;
      const res = await api.aiSearchTerms(projectId, q);
      const terms: Term[] = res.queries.map((t) => ({ query: t.query, why: t.why, on: true, mine: false }));
      if (req.keywords.trim()) terms.push({ query: req.keywords.trim(), why: "Your must-include keywords", on: true, mine: true });
      set({ terms, plannerModel: res.model });
      stage("planner", "done", `${res.queries.length} terms · ${res.model}`);
      log("planner", `Planner suggested ${res.queries.length} terms (${res.model}), labelled AI suggestion`);
    } catch (e) {
      set({ terms: fallbackTerms(req) });
      stage("planner", "error", errText(e, "The AI could not answer"));
      log("planner", `Planner could not answer: ${errText(e, "AI unavailable")}. Using your own words instead.`);
    }
  } else {
    set({ terms: fallbackTerms(req) });
    log("planner", "Planner is locked at AI level 0: using the words of your question");
  }
  stage("gate1", "waiting", "Your turn: approve the search terms");
  log("gate1", "Waiting for you to approve the search terms");
}

export function setTerms(terms: Term[]) {
  set({ terms });
}

// ---------------------------------------------------------------- 2. Scout → Checker → Analyst → checkpoint 2
export async function approveTerms(projectId: string) {
  const s0 = state;
  const req = s0.req!;
  const terms = s0.terms.filter((t) => t.on && t.query.trim()).slice(0, 6);
  if (!terms.length) return;
  stage("gate1", "done", `${terms.length} term${terms.length === 1 ? "" : "s"} approved`);
  log("gate1", `You approved ${terms.length} search terms`);
  api.event(projectId, "SEARCH_TERMS_APPROVED", { queries: terms.map((t) => t.query) });

  // Scout
  stage("scout", "running", "Searching…");
  const byDoi = new Map<string, Candidate>();
  const perQuery: string[][] = [];
  let records = 0;
  for (const [i, t] of terms.entries()) {
    stage("scout", "running", `Searching ${i + 1} of ${terms.length}: “${t.query}”`);
    log("scout", `Scout searches “${t.query}”`);
    try {
      const res = await api.search(projectId, t.query);
      if (res.status !== "ok") { log("scout", `Search could not run: ${res.note}`); perQuery.push([]); continue; }
      const dois: string[] = [];
      for (const r of res.results as SearchResult[]) {
        records++;
        const rec = r.record;
        const doi = rec.doi?.toLowerCase();
        if (!doi) continue;
        if (req.fromYear && (rec.year ?? 0) < req.fromYear) continue;
        if (req.toYear && (rec.year ?? 9999) > req.toYear) continue;
        if (req.journalOnly && rec.type && rec.type !== "journal-article" && rec.type !== "article") continue;
        const have = byDoi.get(doi);
        if (have) { have.queries.push(t.query); continue; }
        byDoi.set(doi, { doi, title: rec.title, authors: rec.authors, year: rec.year, container: rec.container, type: rec.type,
          queries: [t.query], selected: false });
        dois.push(doi);
      }
      perQuery.push(dois);
      log("scout", `${res.results.length} records from ${res.provider}; ${dois.length} new that fit your requirements`);
    } catch (e) {
      perQuery.push([]);
      log("scout", `Search failed: ${errText(e, "network error")}`);
    }
  }
  // interleave the terms' results so every term is represented
  const order: string[] = [];
  for (let k = 0; order.length < byDoi.size && k < 30; k++) for (const list of perQuery) if (list[k] && !order.includes(list[k]!)) order.push(list[k]!);
  const pool = order.map((d) => byDoi.get(d)!);
  const limit = Math.min(pool.length, Math.max(8, req.count * 2 + 2), 16);
  const shortlist = pool.slice(0, limit);
  set({ candidates: shortlist });
  stage("scout", pool.length ? "done" : "error", `${records} records · ${pool.length} fit · ${shortlist.length} to check`);
  log("scout", `Scout found ${records} records, ${pool.length} unique that fit; the top ${shortlist.length} go to the Checker`);
  if (!pool.length) {
    stage("gate1", "waiting", "Nothing fitted: change the terms or the years");
    return;
  }

  // Checker: three at a time, each a full live check plus retraction notices
  stage("checker", "running", `Checking 0 of ${shortlist.length}…`);
  let done = 0;
  const queue = [...shortlist];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        const res = await api.checkFull(projectId, { mode: "doi", doi: c.doi });
        patchCandidate(c.doi, { check: res });
        const ret = res.retraction?.status;
        log("checker", `${res.label === "verified" ? "Verified" : res.label === "not_found" ? "Not found" : "Not yet verified"}: ${c.title.slice(0, 70)}${ret === "retracted" ? " — RETRACTED" : ""}`);
      } catch (e) {
        log("checker", `Could not check ${c.doi}: ${errText(e, "error")}`);
      }
      done++;
      stage("checker", "running", `Checking ${done} of ${shortlist.length}…`);
      await sleep(150);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const checked = state.candidates;
  const verified = checked.filter((c) => c.check?.label === "verified");
  const retracted = verified.filter((c) => c.check?.retraction?.status === "retracted");
  stage("checker", "done", `${verified.length} Verified · ${retracted.length} retracted · ${checked.length - verified.length} not verified`);
  log("checker", `Checker: ${verified.length} Verified, ${retracted.length} retracted (kept out), ${checked.length - verified.length} not verified`);

  // Analyst (plain code on the server)
  const usable = verified.filter((c) => c.check?.retraction?.status !== "retracted");
  if (!usable.length) {
    stage("analyst", "error", "No Verified source to analyse");
    stage("gate2", "waiting", "Nothing to choose: try other terms");
    return;
  }
  stage("analyst", "running", `Reading ${usable.length} abstracts…`);
  log("analyst", `Analyst reads ${usable.length} abstracts and ranks them by relevance (TF-IDF, plain code)`);
  try {
    const res = await api.analyse(projectId, { question: req.question, keywords: req.keywords,
      items: usable.map((c) => ({ doi: c.doi, title: c.title, year: c.year })), claims: req.claims });
    const rank = new Map(res.results.map((r, i) => [r.doi.toLowerCase(), i]));
    const byAnalysis = new Map(res.results.map((r) => [r.doi.toLowerCase(), r]));
    const sorted = [...state.candidates].map((c) => ({ ...c, analysis: byAnalysis.get(c.doi) }))
      .sort((a, b) => (rank.get(a.doi) ?? 999) - (rank.get(b.doi) ?? 999));
    let picked = 0;
    for (const c of sorted) {
      const ok = c.analysis && c.check?.label === "verified" && c.check?.retraction?.status !== "retracted";
      if (ok && picked < req.count && !c.check?.in_list) { c.selected = true; picked++; }
    }
    set({ candidates: sorted, analystMethod: res.method, claimBest: res.claims });
    stage("analyst", "done", `${res.results.length} ranked · ${res.abstracts_found} abstracts`);
    log("analyst", `Analyst ranked ${res.results.length} sources; ${res.abstracts_found} had abstracts. Top ${picked} suggested for you to keep.`);
  } catch (e) {
    stage("analyst", "error", errText(e, "Analysis failed"));
    log("analyst", `Analyst failed: ${errText(e, "error")}`);
  }
  stage("gate2", "waiting", "Your turn: choose the sources to keep");
  log("gate2", "Waiting for you to choose the sources to keep");
}

export function toggleCandidate(doi: string) {
  set((s) => ({ candidates: s.candidates.map((c) => (c.doi === doi ? { ...c, selected: !c.selected } : c)) }));
}

// ---------------------------------------------------------------- 3. checkpoint 2 → Reader → Quote guard → Challenger → Reviewer → Clerk
export async function keepSources(projectId: string, library: () => Reference[], onAdded: () => void) {
  const chosen = state.candidates.filter((c) => c.selected);
  if (!chosen.length) return;
  stage("gate2", "running", `Adding ${chosen.length}…`);
  for (const c of chosen) {
    patchCandidate(c.doi, { add: "adding" });
    try {
      const ref = await api.approve(projectId, { mode: "doi", doi: c.doi });
      patchCandidate(c.doi, { add: "added", rid: ref.id, reading: ref.ai_reading });
      log("gate2", `You added: ${c.title.slice(0, 70)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const have = library().find((r) => r.doi?.toLowerCase() === c.doi);
        patchCandidate(c.doi, { add: "exists", rid: have?.id, reading: have?.ai_reading ?? null });
        log("gate2", `Already in your library: ${c.title.slice(0, 70)}`);
      } else {
        patchCandidate(c.doi, { add: "error", addError: errText(e, "Could not add") });
        log("gate2", `Could not add ${c.title.slice(0, 60)}: ${errText(e, "error")}`);
      }
    }
  }
  onAdded();
  const kept = state.candidates.filter((c) => c.selected && c.rid);
  stage("gate2", "done", `${kept.length} kept by you`);
  api.event(projectId, "SOURCES_CHOSEN", { count: kept.length, dois: kept.map((c) => c.doi) });

  // Reader (AI) and the Quote guard (code)
  if (state.aiLevel >= 2) {
    let n = 0;
    for (const c of kept) {
      n++;
      stage("reader", "running", `Reading ${n} of ${kept.length}…`);
      if (c.reading) continue;
      try {
        const ref = await api.aiRead(projectId, c.rid!);
        patchCandidate(c.doi, { reading: ref.ai_reading });
        log("reader", `Reader quoted ${ref.ai_reading?.kept ?? 0} passages from “${c.title.slice(0, 50)}”`);
      } catch (e) {
        patchCandidate(c.doi, { readError: errText(e, "Could not read") });
        log("reader", `Reader skipped “${c.title.slice(0, 50)}”: ${errText(e, "error")}`);
      }
    }
    const read = state.candidates.filter((c) => c.selected && c.reading);
    stage("reader", "done", `${read.length} of ${kept.length} read`);
    const keptQ = read.reduce((a, c) => a + (c.reading?.kept ?? 0), 0);
    const dropped = read.reduce((a, c) => a + (c.reading?.dropped ?? 0), 0);
    stage("guard", "done", `${keptQ} quotes kept · ${dropped} discarded`);
    log("guard", `Quote guard kept ${keptQ} word-for-word quotes and discarded ${dropped}`);
  } else {
    stage("guard", "skipped", "Nothing to guard: Reader is locked");
  }

  // Challenger (AI): each claim against the kept source that best addresses it
  const req = state.req!;
  if (!req.claims.length) {
    stage("challenger", state.aiLevel >= 3 ? "skipped" : "locked", state.aiLevel >= 3 ? "No claims entered" : "Needs AI level 3");
  } else if (state.aiLevel >= 3 && kept.length) {
    const runs: ClaimRun[] = [];
    for (const [i, claim] of req.claims.entries()) {
      stage("challenger", "running", `Testing claim ${i + 1} of ${req.claims.length}…`);
      const best = state.claimBest.find((x) => x.claim === claim)?.best.map((b) => b.doi) ?? [];
      const target = kept.find((c) => best.includes(c.doi)) ?? kept[0]!;
      try {
        const result = await api.aiClaim(projectId, target.rid!, claim);
        runs.push({ claim, doi: target.doi, rid: target.rid, result });
        log("challenger", `Challenger: “${claim.slice(0, 60)}” → ${result.verdict.replace("_", " ")}`);
      } catch (e) {
        runs.push({ claim, doi: target.doi, rid: target.rid, error: errText(e, "The AI could not answer") });
        log("challenger", `Challenger could not test “${claim.slice(0, 50)}”: ${errText(e, "error")}`);
      }
      set({ claims: [...runs] });
    }
    const bad = runs.filter((r) => r.result && r.result.verdict !== "supported").length;
    stage("challenger", "done", `${runs.length} tested · ${bad} need work`);
  }

  // Reviewer (code)
  stage("reviewer", "running", "Reading the whole project…");
  const review = buildReview(state, library());
  set({ review });
  const fixes = review.filter((r) => r.level === "fix").length;
  const warns = review.filter((r) => r.level === "warn").length;
  stage("reviewer", "done", `${fixes} to fix · ${warns} to check`);
  log("reviewer", `Reviewer: ${fixes} to fix, ${warns} to check`);
  api.event(projectId, "REVIEW_COMPLETED", { fix: fixes, warn: warns });

  // Clerk (code)
  stage("clerk", "done", "APA 7 list and statement ready");
  log("clerk", "Clerk: your APA 7 list and AI-use statement are ready");
  set({ finishedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------- the Reviewer's rules (plain code)
export function buildReview(s: AskState, library: Reference[]): ReviewItem[] {
  const req = s.req!;
  const out: ReviewItem[] = [];
  const kept = s.candidates.filter((c) => c.selected && c.rid);
  const live = library.filter((r) => !r.deleted_at);
  out.push(kept.length >= req.count
    ? { level: "ok", text: `You kept ${kept.length} sources; you asked for ${req.count}.` }
    : { level: "warn", text: `You asked for ${req.count} sources but kept ${kept.length}. Approve more terms or widen the years.` });
  const unverified = live.filter((r) => r.label !== "verified");
  out.push(unverified.length
    ? { level: "fix", text: `${unverified.length} source${unverified.length === 1 ? " in your library is" : "s in your library are"} not Verified. Check again or remove ${unverified.length === 1 ? "it" : "them"}.` }
    : { level: "ok", text: `All ${live.length} sources in your library are Verified.` });
  const retracted = live.filter((r) => r.retraction?.status === "retracted" || r.retraction?.status === "concern");
  if (retracted.length) out.push({ level: "fix", text: `${retracted.length} source${retracted.length === 1 ? " has" : "s have"} a retraction or expression of concern: ${retracted.map((r) => r.title.slice(0, 50)).join("; ")}.` });
  else out.push({ level: "ok", text: "No retraction or expression of concern on any source." });
  const outOfRange = kept.filter((c) => (req.fromYear && (c.year ?? 0) < req.fromYear) || (req.toYear && (c.year ?? 0) > req.toYear));
  if (outOfRange.length) out.push({ level: "warn", text: `${outOfRange.length} kept source${outOfRange.length === 1 ? " is" : "s are"} outside your year range.` });
  const thisYear = new Date().getFullYear();
  if (kept.length && !kept.some((c) => (c.year ?? 0) >= thisYear - 5)) out.push({ level: "warn", text: "None of your sources is from the last five years. A marker may ask whether newer work exists." });
  const venues = new Map<string, number>();
  kept.forEach((c) => { const v = (c.container || c.analysis?.venue || "").toLowerCase(); if (v) venues.set(v, (venues.get(v) ?? 0) + 1); });
  const top = [...venues.entries()].sort((a, b) => b[1] - a[1])[0];
  if (kept.length >= 3 && top && top[1] / kept.length > 0.5) out.push({ level: "warn", text: `More than half of your sources come from one journal (${top[0]}). Consider a wider spread.` });
  const strong = kept.filter((c) => /Meta-analysis|Randomised|Quasi|Longitudinal/.test(c.analysis?.design ?? ""));
  out.push(kept.length && !strong.length
    ? { level: "warn", text: "No kept source uses a strong design (meta-analysis, experiment or panel data). Say so as a limitation." }
    : { level: "ok", text: `${strong.length} of ${kept.length} kept sources use a strong design (${[...new Set(strong.map((c) => c.analysis!.design))].join(", ") || "none"}).` });
  const noAbstract = kept.filter((c) => c.analysis && !c.analysis.has_abstract);
  if (noAbstract.length) out.push({ level: "warn", text: `${noAbstract.length} kept source${noAbstract.length === 1 ? " has" : "s have"} no abstract on record, so the AI could not read ${noAbstract.length === 1 ? "it" : "them"}. Read ${noAbstract.length === 1 ? "it" : "them"} yourself.` });
  for (const c of s.claims) {
    if (c.result?.verdict === "supported") out.push({ level: "ok", text: `Claim supported by its source: “${c.claim.slice(0, 80)}”.` });
    else if (c.result) out.push({ level: c.result.verdict === "contradicted" ? "fix" : "warn",
      text: `${c.result.verdict === "contradicted" ? "Claim not supported as written" : c.result.verdict === "not_addressed" ? "The source does not address this claim" : "The AI's answer was discarded"}: “${c.claim.slice(0, 80)}”.${c.result.numbers && !c.result.numbers.ok ? ` ${c.result.numbers.text}` : ""}` });
    else if (c.error) out.push({ level: "warn", text: `Claim not tested (${c.error}): “${c.claim.slice(0, 60)}”.` });
  }
  return out;
}
