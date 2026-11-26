// "How it works" and "House rules". Every statement here describes what the code
// in this repository does (backend/records.py, backend/verify.py, backend/app.py).
import { BookOpenCheck, ScrollText } from "lucide-react";
import { TrustKey } from "./TrustLabel";

const FLOW = [
  { k: "You", t: "paste a reference, a DOI or a list, or search" },
  { k: "Registries", t: "Crossref, doi.org and OpenAlex are asked live" },
  { k: "Plain code", t: "compares title, authors, year and DOI" },
  { k: "Trust label", t: "Verified, Not yet verified or Not found" },
  { k: "Your click", t: "the server checks again, then adds it" },
  { k: "Outputs", t: "APA 7 list and AI-use statement" },
];

export function GuidePage() {
  return (
    <div className="page info">
      <header className="page-head">
        <h1><BookOpenCheck size={22} aria-hidden="true" /> How Paper Trail works</h1>
        <p className="hint">Paper Trail helps you find real sources, check the ones you have, and cite them honestly. Code decides whether a reference is real; you decide what goes in.</p>
      </header>

      <section className="panel">
        <h2 className="panel-title">From your paste to your reference list</h2>
        <ol className="flow" aria-label="How a reference moves through Paper Trail">
          {FLOW.map((s, i) => (
            <li key={s.k}>
              <b>{i + 1}. {s.k}</b>
              <span>{s.t}</span>
            </li>
          ))}
        </ol>
      </section>

      <TrustKey />

      <section className="panel">
        <h2 className="panel-title">The five steps in the workspace</h2>
        <dl className="info-list">
          <dt>Find</dt>
          <dd>Add → Search sends your words to Crossref (and OpenAlex as a backup). Each result is labelled before you see it. Nothing is added by searching.</dd>
          <dt>Check</dt>
          <dd>Add → Check takes one reference, typed in fields or pasted as text. Add → Import takes a whole list, a BibTeX file or a RIS file, and checks each line.</dd>
          <dt>Your paper</dt>
          <dd>Upload your draft (Word .docx, PDF, .odt, .txt or .md). It is read in your browser and never uploaded. Code finds the reference list and every in-text citation, shows citations missing from the list and references never cited, checks each reference live, and lets you add the real ones to your library. The Challenger can then test each citing sentence.</dd>
          <dt>Approve</dt>
          <dd>The Add button on a result is the only way a source enters your library. The server runs the check again before it saves, and refuses anything Not found.</dd>
          <dt>Cite</dt>
          <dd>The APA 7 list is formatted from the registry’s own record (Citation Style Language). Copy it, or download it as text, BibTeX or RIS. Only Verified sources are exported.</dd>
          <dt>Declare</dt>
          <dd>The AI-use statement is written from your project’s activity log: what you searched, what was checked, what you approved. Copy it into your assignment.</dd>
        </dl>
      </section>

      <section className="panel">
        <h2 className="panel-title">Where AI is used</h2>
        <p className="hint">Three AI agents run on Google Gemini, with NVIDIA Nemotron and Groq as backups when their keys are set (the first good answer is used, and the model is recorded in the log). Each one is followed by plain code that checks what it said before you see it, and each is switched on or off by the project’s AI level, at the server as well as on screen.</p>
        <dl className="info-list">
          <dt>Planner</dt>
          <dd>Level 1. Add → Search → <b>Suggest search terms with AI</b> turns your research question into five search queries. The searches go to Crossref and OpenAlex, so every result is a real registry record with its own trust label. Code drops any query that contains a DOI.</dd>
          <dt>Reader</dt>
          <dd>Level 2. In a Verified source’s details, <b>Read the abstract with AI</b> points at the sentences that state the aim, method, findings and limits. The quote guard (code) keeps a quote only if it appears word for word in the abstract and discards the rest.</dd>
          <dt>Challenger</dt>
          <dd>Level 3. <b>Check my sentence</b> asks whether the source’s abstract supports something you wrote. Its quote must pass the quote guard, and code compares the numbers in your sentence with the numbers in the source: if they differ, code overrules the AI.</dd>
        </dl>
        <p className="hint">What AI never does: decide whether a reference is real, write a reference, add anything to your library, or write your assignment. Every AI output carries the <b>AI suggestion</b> label, and every AI run is recorded in the activity log, so the AI-use statement lists it.</p>
      </section>
    </div>
  );
}

export function RulesPage() {
  return (
    <div className="page info">
      <header className="page-head">
        <h1><ScrollText size={22} aria-hidden="true" /> House rules</h1>
        <p className="hint">The rules the checker follows, exactly as the code applies them. They are deliberately strict: a real paper may sometimes need more detail, but a fake one should never pass.</p>
      </header>

      <section className="panel">
        <h2 className="panel-title">When a reference is Verified</h2>
        <ul className="rules">
          <li><b>DOI.</b> doi.org must say the DOI is registered, and it must resolve to a record.</li>
          <li><b>Title.</b> At least 90% similar to the registered title, after removing case, accents and punctuation. If you give only a title, the bar is 97%.</li>
          <li><b>Authors.</b> Every author name you give must appear on the record, and at least one family name must match.</li>
          <li><b>Year.</b> Must be one of the record’s publication years (issued, print or online).</li>
          <li><b>All of them.</b> Any field you give that does not match stops the reference being Verified.</li>
        </ul>
      </section>

      <section className="panel">
        <h2 className="panel-title">When it is not</h2>
        <ul className="rules">
          <li><b>Not found</b> only when every database asked has answered and none has a match, or doi.org says the DOI is not registered.</li>
          <li><b>Not yet verified</b> when a database did not answer. An outage never looks like a pass, and never looks like a fake.</li>
          <li><b>Short titles.</b> A title with fewer than four meaningful words, and no matching author or year, is Not yet verified: titles that short fit many works.</li>
          <li><b>Placeholders</b> such as [citation needed], TODO, TBD or (Author, Year) are refused as input.</li>
          <li><b>Retractions.</b> A Verified reference with a DOI is checked against Crossref’s update notices, which include Retraction Watch data. A retraction is shown on the reference.</li>
        </ul>
      </section>

      <section className="panel">
        <h2 className="panel-title">What you control</h2>
        <ul className="rules">
          <li>Nothing is added automatically. Only your click adds a source, and the server checks it again first.</li>
          <li>A Not found reference can never be added. A Not yet verified one keeps its label until it is checked again.</li>
          <li>Deleting moves a source to Trash first. Removing it for good is a separate step.</li>
          <li>Guest projects work without an account. Sign in to keep a library private to you and use it on any device.</li>
          <li>The AI level (0–3) on the Project page sets which AI agents may run. Agents above it are refused by the server.</li>
          <li>AI reads only Verified sources, and only their abstracts. An AI quote that is not word for word in the source is thrown away.</li>
        </ul>
      </section>
    </div>
  );
}
