import { useState } from "react";
import { LABELS, LABEL_ORDER } from "../labels";
import type { Label } from "../types";

export function TrustLabel({ label, size = "md" }: { label: Label; size?: "sm" | "md" }) {
  const meta = LABELS[label];
  return (
    <span className={`lbl ${meta.className}${size === "sm" ? " lbl-sm" : ""}`} title={meta.meaning}>
      <span className="lbl-dot" aria-hidden="true" />
      {meta.text}
    </span>
  );
}

/** The on-screen key that explains every trust label (full meanings). */
export function TrustKey() {
  return (
    <section className="trust-key" aria-labelledby="trust-key-title">
      <h2 id="trust-key-title" className="trust-key-title">Trust labels — every reference and claim carries one</h2>
      <ul className="trust-key-list">
        {LABEL_ORDER.map((label) => (
          <li key={label}>
            <TrustLabel label={label} />
            <span className="trust-key-meaning">{LABELS[label].meaning}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A slim, always-visible legend above the library: each label with its short
 * meaning, and the full meanings one click away. */
export function TrustLegend() {
  const [open, setOpen] = useState(false);
  return (
    <section className="legend" aria-label="What the trust labels mean">
      <ul className="legend-list">
        {LABEL_ORDER.map((label) => (
          <li key={label}>
            <TrustLabel label={label} size="sm" />
            <span className="legend-meaning">{open ? LABELS[label].meaning : LABELS[label].short}</span>
          </li>
        ))}
      </ul>
      <button className="legend-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Less" : "What do these mean?"}
      </button>
    </section>
  );
}
