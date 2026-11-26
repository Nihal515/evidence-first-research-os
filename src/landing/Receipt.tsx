// A check result drawn as a receipt, in the style of Team 1's Paper Trail
// (src/ui/Receipt.tsx), but showing this app's own trust labels and checks.
import { LABELS } from "../labels";
import type { CheckResult, Label, Retraction } from "../types";
import css from "./Receipt.module.css";

const TONE: Record<Label, { tone: string; mark: string }> = {
  verified: { tone: "ok", mark: "✓" },
  not_yet_verified: { tone: "warn", mark: "?" },
  ai_suggestion: { tone: "mute", mark: "AI" },
  not_found: { tone: "bad", mark: "✕" },
};

const STATUS = { match: "matches", mismatch: "does not match", not_provided: "not given" } as const;

export type PublicCheck = CheckResult & { retraction?: Retraction | null };

/** The strip at the foot of a receipt, like a passport's machine-readable line. */
export function strip(c: PublicCheck): string {
  const up = (s: string) => s.toUpperCase().normalize("NFKD").replace(/[^A-Z0-9./-]+/g, "<");
  const r = c.record;
  if (!r || c.label === "not_found") return "REF<<<<<<<<<<<< NO RECORD <<<<<<<<<<<<";
  const names = r.authors.slice(0, 4).map((a) => up(a.split(/\s+/).pop() || a)).join("<");
  const tail = c.label === "verified" ? "" : `${up(LABELS[c.label].text)}<<`;
  return `REF<<${names}<<${r.year ?? ""}<<${r.doi ? up(r.doi) : ""}<<${tail}`;
}

export function Receipt({ check, children }: { check: PublicCheck; children?: React.ReactNode }) {
  const t = TONE[check.label];
  const r = check.record;
  const showRecord = r && check.label !== "not_found";
  const ret = check.retraction;
  const fields = check.checks.filter((f) => f.status !== "not_provided" || f.detail);
  return (
    <article className={`${css.receipt} ${css.feed}`} data-label={check.label}>
      <header className={css.head}>
        <span className={`stamp t-${t.tone} land`}>
          <i aria-hidden="true">{t.mark}</i>
          {LABELS[check.label].text}
        </span>
      </header>
      <p className={css.plain}>{LABELS[check.label].meaning}</p>
      <ul className={css.reasons}>
        <li>{check.reason}</li>
      </ul>
      {fields.length > 0 && (
        <table className={css.diff}>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Check</th>
              <th scope="col">What was compared</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.field} data-ok={f.status !== "mismatch"}>
                <th scope="row">
                  <span aria-hidden="true">{f.status === "match" ? "✓" : f.status === "mismatch" ? "≠" : "–"}</span> {f.field}
                </th>
                <td>{STATUS[f.status]}</td>
                <td>{f.detail || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showRecord && (
        <dl className={css.facts}>
          <dt>Title</dt>
          <dd>{r.title}</dd>
          <dt>Authors</dt>
          <dd>{r.authors.join(", ") || "none listed"}</dd>
          <dt>Year</dt>
          <dd>{r.year ?? "not stated"}</dd>
          {r.container && (
            <>
              <dt>Published in</dt>
              <dd>{r.container}</dd>
            </>
          )}
        </dl>
      )}
      {ret?.status === "retracted" && <p className={css.retract}>{ret.detail}</p>}
      {ret && (ret.status === "concern" || ret.status === "corrected") && (
        <ul className={css.notices} aria-label="Published about this work later">
          <li>{ret.detail}</li>
        </ul>
      )}
      <p className={css.asked}>
        Asked: {check.sources_checked.join(" · ") || "no database"}
        {check.unavailable.length > 0 && <> · did not answer: {check.unavailable.join(", ")}</>}
        {ret?.status === "none_found" && <> · Retraction: none found in Crossref</>}
        {ret?.status === "unknown" && <> · Retraction: could not be checked</>}
        {showRecord && r.doi && (
          <>
            {" · "}
            <a href={`https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">
              Open the source
            </a>
          </>
        )}
      </p>
      <p className={css.strip} aria-hidden="true">
        {strip(check)}
      </p>
      {children && <div className={css.actions}>{children}</div>}
    </article>
  );
}
