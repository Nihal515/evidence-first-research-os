import { LABELS, LABEL_ORDER } from "../labels";
import type { Label } from "../types";

export function TrustLabel({ label }: { label: Label }) {
  const meta = LABELS[label];
  return (
    <span className={`lbl ${meta.className}`} title={meta.meaning}>
      <span className="lbl-dot" aria-hidden="true" />
      {meta.text}
    </span>
  );
}

/** The on-screen key that explains every trust label. Shown on every page. */
export function TrustKey() {
  return (
    <section className="trust-key" aria-labelledby="trust-key-title">
      <h2 id="trust-key-title" className="trust-key-title">
        Trust labels — every reference and claim carries one
      </h2>
      <ul className="trust-key-list">
        {LABEL_ORDER.map((label) => (
          <li key={label}>
            <TrustLabel label={label} />
            <span className="trust-key-meaning trust-long">{LABELS[label].meaning}</span>
            <span className="trust-key-meaning trust-short">{LABELS[label].short}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
