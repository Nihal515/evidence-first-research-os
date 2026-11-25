import { useMemo, useState } from "react";
import { formatBibliography } from "../lib/apa";
import { exportable } from "../lib/citations";
import { EXPORT_LABELS, runExport, type ExportFormat } from "../lib/exportActions";
import type { Reference } from "../types";

interface Props {
  projectId: string;
  references: Reference[]; // active (not in Trash)
}

/** The whole library as an APA 7 reference page, with every export format. */
export function ReferenceListView({ projectId, references }: Props) {
  const [message, setMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const { items, excluded } = exportable(references);
  const { html, failed } = useMemo(() => {
    try {
      return { html: formatBibliography(items, "html"), failed: false };
    } catch {
      return { html: [] as string[], failed: true };
    }
  }, [items.map((i) => i.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(format: ExportFormat) {
    setMessage(await runExport(projectId, references, format));
  }

  return (
    <div className="page">
      <section className="panel export" aria-labelledby="apa-title">
        <h2 id="apa-title">Reference list — APA 7th edition</h2>
        <p className="hint">Built from each publisher’s registered metadata. Only Verified references are included.</p>
        {failed && <p className="error">The formatter could not build the list. Please reload the page.</p>}
        {!failed && items.length === 0 && <p className="empty">Approve a Verified source to build your APA 7 list.</p>}
        {!failed && items.length > 0 && (
          <>
            <div className="apa-preview">
              <p className="apa-heading">References</p>
              {html.map((h, i) => <p key={i} className="apa-entry" dangerouslySetInnerHTML={{ __html: h }} />)}
            </div>
            <div className="actions">
              <button className="btn-primary" onClick={() => run("apa-copy")}>Copy APA 7 list</button>
              <button className="btn-secondary" onClick={() => run("apa-docx")}>Download Word (.docx)</button>
              <button className="btn-ghost" onClick={() => run("apa-txt")}>Download text (.txt)</button>
              <button className="btn-ghost" onClick={() => run("bibtex")}>{EXPORT_LABELS.bibtex}</button>
              <button className="btn-ghost" onClick={() => run("ris")}>{EXPORT_LABELS.ris}</button>
            </div>
            {message && <p className={message.ok ? "success" : "error"} role="status">{message.message}</p>}
            <p className="hint small">
              Formatted by citeproc-js with the official APA 7 style. APA uses sentence case for article titles; titles
              appear as the publisher registered them, so check capitalisation before you submit.
            </p>
          </>
        )}
        {excluded > 0 && (
          <p className="notice notice-warn">
            {excluded} reference{excluded === 1 ? " is" : "s are"} left out because {excluded === 1 ? "it is" : "they are"} not
            verified. Open {excluded === 1 ? "it" : "them"} in the library and use <b>Check again</b>.
          </p>
        )}
      </section>
    </div>
  );
}
