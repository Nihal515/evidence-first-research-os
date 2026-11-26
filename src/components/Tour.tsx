// The 60-second tour: six steps of ten seconds, opened from the landing page
// ("Play the 60-second tour") or the workspace's More menu. It describes only what
// this workspace actually does.
import { useEffect, useRef, useState } from "react";
import { go } from "../router";
import css from "./Tour.module.css";

export const TOUR_EVENT = "pt:tour";
export const startTour = () => window.dispatchEvent(new Event(TOUR_EVENT));

const STEP_MS = 10_000;

const STEPS = [
  {
    title: "Every reference carries a trust label",
    body: "Verified, Not yet verified, AI suggestion or Not found. The label says what was checked, and a key on screen explains each one.",
  },
  {
    title: "1. Find real papers",
    body: "Add → Search asks Crossref and OpenAlex live, and AI can suggest search terms from your question. Results are labelled before you see them, and nothing is added yet.",
  },
  {
    title: "2. Check what you already have",
    body: "Paste a reference, a DOI or a whole list. Plain code compares title, authors, year and DOI against the record. A fake reference is never Verified.",
  },
  {
    title: "3. Approve with one click",
    body: "Only your click adds a source, and the server checks it again first. A Not found reference can never be added.",
  },
  {
    title: "4. Cite in APA 7",
    body: "The reference list is built from the registry record, not from your typing. Copy it or download it as a file.",
  },
  {
    title: "5. Let AI read, then declare it",
    body: "AI quotes a source's aim, method and findings, and tests your sentences against it; code throws away any quote that is not in the source. The AI-use statement lists every AI run, ready to paste.",
  },
];

export function Tour() {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const on = () => {
      opener.current = document.activeElement;
      setI(0);
      setElapsed(0);
      setPaused(false);
      setOpen(true);
    };
    window.addEventListener(TOUR_EVENT, on);
    return () => window.removeEventListener(TOUR_EVENT, on);
  }, []);

  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  // advance every ten seconds unless paused
  useEffect(() => {
    if (!open || paused) return;
    const t = setInterval(() => setElapsed((e) => e + 250), 250);
    return () => clearInterval(t);
  }, [open, paused]);
  useEffect(() => {
    if (elapsed < STEP_MS) return;
    if (i < STEPS.length - 1) {
      setI(i + 1);
      setElapsed(0);
    } else setPaused(true);
  }, [elapsed, i]);

  function close() {
    setOpen(false);
    (opener.current as HTMLElement | null)?.focus?.();
  }
  const step = (n: number) => {
    setI(Math.max(0, Math.min(STEPS.length - 1, n)));
    setElapsed(0);
  };

  if (!open) return null;
  const s = STEPS[i]!;
  const last = i === STEPS.length - 1;
  return (
    <div className={css.scrim} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className={css.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "ArrowRight") step(i + 1);
          if (e.key === "ArrowLeft") step(i - 1);
        }}
      >
        <p className={css.kicker}>
          Paper Trail tour · {i + 1} of {STEPS.length}
        </p>
        <h2 id="tour-title" className={css.title}>{s.title}</h2>
        <p className={css.body} aria-live="polite">{s.body}</p>
        <div className={css.bar} aria-hidden="true">
          {STEPS.map((_, n) => (
            <span key={n}>
              <i style={{ width: n < i ? "100%" : n === i ? `${Math.min(100, (elapsed / STEP_MS) * 100)}%` : "0%" }} />
            </span>
          ))}
        </div>
        <div className={css.actions}>
          <button type="button" onClick={() => step(i - 1)} disabled={i === 0}>Back</button>
          <button type="button" onClick={() => setPaused((p) => !p)}>{paused ? "Play" : "Pause"}</button>
          {last ? (
            <button type="button" className={css.main} onClick={() => { close(); if (window.location.pathname === "/") go("/home"); }}>
              {window.location.pathname === "/" ? "Open the workspace" : "Done"}
            </button>
          ) : (
            <button type="button" className={css.main} onClick={() => step(i + 1)}>Next</button>
          )}
          <button type="button" className={css.close} onClick={close} aria-label="Close the tour">Close</button>
        </div>
      </div>
    </div>
  );
}
