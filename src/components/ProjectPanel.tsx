import { useState } from "react";
import { api, ApiError } from "../api";
import type { Project } from "../types";

interface Props {
  project: Project | null;
  onProject: (p: Project) => void;
  onNewProject: () => void;
}

export function ProjectPanel({ project, onProject, onNewProject }: Props) {
  const [title, setTitle] = useState(project?.title ?? "");
  const [question, setQuestion] = useState(project?.question ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved(false);
    if (!title.trim()) {
      setError("Give your project a title.");
      return;
    }
    setBusy(true);
    try {
      const p = project
        ? await api.updateProject(project.id, title.trim(), question.trim())
        : await api.createProject(title.trim(), question.trim());
      onProject(p);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>{project ? "Your research project" : "Start a research project"}</h2>
      <p className="hint">
        Your project keeps your reference list, every check and your activity log together. Nothing is added to your
        reference list unless you approve it.
      </p>
      <form onSubmit={submit} className="form">
        <label>
          Project title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="e.g. AI tutoring in secondary schools" required />
        </label>
        <label>
          Research question <span className="optional">(optional)</span>
          <textarea value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={2000} rows={3}
            placeholder="e.g. Does AI tutoring improve maths outcomes for secondary students?" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        {saved && <p className="success" role="status">Saved.</p>}
        <div className="actions">
          <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : project ? "Save changes" : "Create project"}</button>
          {project && (
            <button type="button" className="btn-ghost" onClick={onNewProject}>Start a new project</button>
          )}
        </div>
      </form>

      <h3 className="steps-title">How it works</h3>
      <ol className="steps">
        <li><b>Find sources</b> — search live scholarly records (Crossref, with OpenAlex as a fallback).</li>
        <li><b>Check a reference</b> — any reference, including ones an AI gave you, is checked live against Crossref, doi.org and OpenAlex.</li>
        <li><b>Approve with one click</b> — only then is a source added to your reference list.</li>
        <li><b>Export</b> — copy or download your list in APA 7th edition, and paste the AI-use statement into your assignment.</li>
      </ol>
    </div>
  );
}
