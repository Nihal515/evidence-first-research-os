import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { CheckPanel } from "./components/CheckPanel";
import { FindPanel } from "./components/FindPanel";
import { ProjectPanel } from "./components/ProjectPanel";
import { ReferencesPanel } from "./components/ReferencesPanel";
import { StatementPanel } from "./components/StatementPanel";
import { TrustKey } from "./components/TrustLabel";
import type { Project, Reference } from "./types";

type Tab = "project" | "find" | "check" | "refs" | "statement";
const TABS: { id: Tab; label: string; short: string }[] = [
  { id: "project", label: "Project", short: "Project" },
  { id: "find", label: "Find sources", short: "Find" },
  { id: "check", label: "Check a reference", short: "Check" },
  { id: "refs", label: "My references", short: "References" },
  { id: "statement", label: "AI-use statement", short: "AI use" },
];
const KEY = "efro.projectId";

function storedId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function storeId(id: string | null) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the project still works for this visit */
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>("project");
  const [project, setProject] = useState<Project | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbState, setDbState] = useState<string>("checking");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const loadReferences = useCallback(async (pid: string) => {
    try {
      setReferences(await api.references(pid));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your references.");
    }
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    api.health().then((h) => setDbState(h.database)).catch(() => setDbState("error"));
    const id = storedId();
    if (!id) {
      setLoading(false);
      return;
    }
    api.getProject(id)
      .then((p) => {
        setProject(p);
        setTab("find");
        return loadReferences(p.id);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) storeId(null);
        else setError(err instanceof ApiError ? err.message : "Could not load your project.");
      })
      .finally(() => setLoading(false));
  }, [loadReferences]);

  function onProject(p: Project) {
    const isNew = !project || project.id !== p.id;
    setProject(p);
    storeId(p.id);
    if (isNew) {
      setReferences([]);
      setTab("find");
    }
    setRefreshKey((k) => k + 1);
  }

  function newProject() {
    storeId(null);
    setProject(null);
    setReferences([]);
    setTab("project");
  }

  const needsProject = !project && tab !== "project";

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">EF</span>
          <div>
            <h1>Evidence-First Research OS</h1>
            <p className="tagline">{project ? project.title : "Find, check and cite sources honestly"}</p>
          </div>
        </div>
        <nav className="tabs-top" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "tab tab-on" : "tab"} onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}>
              {t.label}{t.id === "refs" && references.length ? ` (${references.length})` : ""}
            </button>
          ))}
        </nav>
      </header>

      <main className="main">
        {dbState !== "connected" && dbState !== "checking" && (
          <div className="notice notice-warn" role="alert">
            The database is not connected yet, so projects cannot be saved. Live checks will work once it is connected.
          </div>
        )}
        {error && <div className="notice notice-warn" role="alert">{error}</div>}

        <TrustKey />

        {loading ? (
          <p className="empty">Loading…</p>
        ) : needsProject ? (
          <div className="panel">
            <h2>Start with a project</h2>
            <p className="hint">Create a project first so your references and activity log are kept together.</p>
            <button className="btn-primary" onClick={() => setTab("project")}>Create a project</button>
          </div>
        ) : (
          <>
            {tab === "project" && <ProjectPanel key={project?.id ?? "new"} project={project} onProject={onProject} onNewProject={newProject} />}
            {tab === "find" && project && <FindPanel projectId={project.id} onAdded={() => loadReferences(project.id)} />}
            {tab === "check" && project && <CheckPanel projectId={project.id} onAdded={() => loadReferences(project.id)} />}
            {tab === "refs" && project && <ReferencesPanel projectId={project.id} references={references} onChange={() => loadReferences(project.id)} />}
            {tab === "statement" && project && <StatementPanel projectId={project.id} refreshKey={refreshKey} />}
          </>
        )}

        <footer className="footer">
          <p>
            All results are live — no sample data. Sources: Crossref (including Retraction Watch data), doi.org, OpenAlex.
            APA 7 style: Citation Style Language project, CC BY-SA 3.0.
          </p>
          <p>AI Club Hackathon 2026 · Nihal Pusthe · Yash Petkar · Siddal · Hemanth</p>
        </footer>
      </main>

      <nav className="tabs-bottom" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "btab btab-on" : "btab"} onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}>
            <span>{t.short}</span>
            {t.id === "refs" && references.length > 0 && <span className="btab-count">{references.length}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
