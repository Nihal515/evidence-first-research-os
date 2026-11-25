import { FolderCog, Library, Quote, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import { AddDialog } from "./components/AddDialog";
import { DetailPanel } from "./components/DetailPanel";
import { DuplicatesView } from "./components/DuplicatesView";
import { LibraryView } from "./components/LibraryView";
import { ProjectPanel } from "./components/ProjectPanel";
import { ReferenceListView } from "./components/ReferenceListView";
import { Sidebar } from "./components/Sidebar";
import { StatementPanel } from "./components/StatementPanel";
import { COMPACT_QUERY, useMedia } from "./hooks";
import { runExport, type ExportFormat } from "./lib/exportActions";
import { refsForView, viewCounts, viewTitle, type View } from "./lib/library";
import type { BulkAction, Collection, Project, Reference } from "./types";

type Page = "library" | "list" | "statement" | "project";
const PAGES: { id: Page; label: string; short: string; icon: typeof Library }[] = [
  { id: "library", label: "Library", short: "Library", icon: Library },
  { id: "list", label: "Reference list (APA 7)", short: "APA list", icon: Quote },
  { id: "statement", label: "AI-use statement", short: "AI use", icon: ShieldCheck },
  { id: "project", label: "Project", short: "Project", icon: FolderCog },
];

const KEY = "efro.projectId";
const LIST_KEY = "efro.projects";

function storage<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback; // storage unavailable: everything still works for this visit
  }
}
const storedId = () => storage(() => localStorage.getItem(KEY), null);
const storeId = (id: string | null) =>
  storage(() => (id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY)), undefined);
const storedProjects = (): { id: string; title: string }[] =>
  storage(() => JSON.parse(localStorage.getItem(LIST_KEY) || "[]"), []);
function rememberProject(p: Project) {
  const list = storedProjects().filter((x) => x.id !== p.id);
  storage(() => localStorage.setItem(LIST_KEY, JSON.stringify([{ id: p.id, title: p.title }, ...list].slice(0, 20))), undefined);
}
function forgetProject(id: string) {
  storage(() => localStorage.setItem(LIST_KEY, JSON.stringify(storedProjects().filter((x) => x.id !== id))), undefined);
}

export default function App() {
  const compact = useMedia(COMPACT_QUERY);
  const [project, setProject] = useState<Project | null>(null);
  const [refs, setRefs] = useState<Reference[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [dups, setDups] = useState<{ groups: string[][]; rule: string }>({ groups: [], rule: "" });
  const [page, setPage] = useState<Page>("library");
  const [view, setView] = useState<View>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ ok: boolean; message: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Collection | null>(null);
  const [loading, setLoading] = useState(true);
  const [dbState, setDbState] = useState("checking");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const reload = useCallback(async (pid: string) => {
    try {
      const lib = await api.library(pid); // one request: references, collections, duplicates
      setRefs(lib.references);
      setCollections(lib.collections);
      setDups(lib.duplicates);
      setError("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your library.");
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
        rememberProject(p);
        return reload(p.id);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          storeId(null);
          forgetProject(id);
        } else setError(err instanceof ApiError ? err.message : "Could not load your project.");
      })
      .finally(() => setLoading(false));
  }, [reload]);

  // close the detail panel with Escape (desktop)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !addOpen) setActiveId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [addOpen]);

  const dupIds = useMemo(() => new Set(dups.groups.flat()), [dups]);
  const counts = useMemo(() => viewCounts(refs, collections, dupIds), [refs, collections, dupIds]);
  const viewRefs = useMemo(() => refsForView(refs, view, Date.now(), dupIds), [refs, view, dupIds]);
  const byId = useMemo(() => new Map(refs.map((r) => [r.id, r])), [refs]);
  const active = activeId ? byId.get(activeId) ?? null : null;
  const activeRefs = useMemo(() => refs.filter((r) => !r.deleted_at), [refs]);
  const currentCollection = view.kind === "collection" ? collections.find((c) => c.id === view.collectionId) ?? null : null;

  function onProject(p: Project) {
    const isNew = !project || project.id !== p.id;
    setProject(p);
    storeId(p.id);
    rememberProject(p);
    if (isNew) {
      setRefs([]);
      setCollections([]);
      setDups({ groups: [], rule: "" });
      setView({ kind: "all" });
      setPage("library");
      reload(p.id);
    }
    setRefreshKey((k) => k + 1);
  }

  async function switchProject(id: string) {
    try {
      const p = await api.getProject(id);
      setActiveId(null);
      setSelected(new Set());
      onProject(p);
    } catch {
      forgetProject(id);
      setError("That project could not be opened.");
    }
  }

  function newProject() {
    storeId(null);
    setProject(null);
    setRefs([]);
    setCollections([]);
    setActiveId(null);
    setPage("library");
  }

  function changeView(v: View) {
    setView(v);
    setSelected(new Set());
    setActiveId(null);
    setDrawer(false);
    setPage("library");
    setExportMessage(null);
  }

  async function onFavorite(r: Reference) {
    if (!project) return;
    setRefs((rs) => rs.map((x) => (x.id === r.id ? { ...x, favorite: !r.favorite } : x)));
    try {
      await api.patch(project.id, r.id, { favorite: !r.favorite });
    } finally {
      reload(project.id);
    }
  }

  async function onBulk(action: BulkAction, ids: string[], collectionId?: string) {
    if (!project) return;
    let message: { ok: boolean; message: string } | null = null;
    try {
      const res = await api.bulk(project.id, ids, action, collectionId);
      if (action === "add_to_collection") {
        const name = collections.find((c) => c.id === collectionId)?.name;
        message = { ok: true, message: res.count ? `Filed ${res.count} reference${res.count === 1 ? "" : "s"} in ${name}.` : `Already in ${name}.` };
      }
      if (action === "trash") message = { ok: true, message: `Moved ${ids.length} to Trash. You can restore ${ids.length === 1 ? "it" : "them"} from Trash.` };
      if (["trash", "delete_forever"].includes(action) && activeId && ids.includes(activeId)) setActiveId(null);
    } catch (err) {
      message = { ok: false, message: err instanceof ApiError ? err.message : "That did not work." };
    }
    await reload(project.id); // show the confirmation only once the library reflects it
    if (message) setExportMessage(message);
  }

  async function onExport(format: ExportFormat, scope: Reference[]) {
    if (project) setExportMessage(await runExport(project.id, scope, format));
  }

  async function createCollection(name: string, parentId: string | null): Promise<boolean> {
    if (!project) return false;
    try {
      await api.createCollection(project.id, name, parentId);
      await reload(project.id);
      return true;
    } catch {
      return false;
    }
  }

  async function renameCollection(id: string, name: string): Promise<boolean> {
    if (!project) return false;
    try {
      await api.renameCollection(project.id, id, name);
      await reload(project.id);
      return true;
    } catch {
      return false;
    }
  }

  async function confirmDeleteCollection() {
    if (!project || !pendingDelete) return;
    await api.deleteCollection(project.id, pendingDelete.id).catch(() => undefined);
    if (view.kind === "collection" && view.collectionId === pendingDelete.id) setView({ kind: "all" });
    setPendingDelete(null);
    reload(project.id);
  }

  function onDetailChanged(updated?: Reference) {
    if (updated) setRefs((rs) => rs.map((x) => (x.id === updated.id ? updated : x)));
    if (project) reload(project.id);
  }

  // ---------------------------------------------------------------- start screen
  if (loading) return <p className="empty boot">Loading…</p>;

  if (!project) {
    const others = storedProjects();
    return (
      <div className="welcome">
        <div className="welcome-brand">
          <span className="brand-mark" aria-hidden="true">EF</span>
          <div>
            <h1>Evidence-First Research OS</h1>
            <p className="tagline">Find, check, organise and cite sources honestly</p>
          </div>
        </div>
        {dbState !== "connected" && dbState !== "checking" && (
          <div className="notice notice-warn" role="alert">The database is not connected, so projects cannot be saved yet.</div>
        )}
        {error && <div className="notice notice-warn" role="alert">{error}</div>}
        <ProjectPanel project={null} onProject={onProject} onNewProject={newProject} />
        {others.length > 0 && (
          <section className="panel">
            <h3>Your projects on this device</h3>
            <ul className="project-list">
              {others.map((x) => <li key={x.id}><button className="btn-ghost" onClick={() => switchProject(x.id)}>{x.title}</button></li>)}
            </ul>
          </section>
        )}
        <Footer />
      </div>
    );
  }

  // ---------------------------------------------------------------- main shell
  const sidebar = (
    <Sidebar project={project} view={view} counts={counts} collections={collections} onView={changeView}
      onAdd={() => { setDrawer(false); setAddOpen(true); }}
      onCreateCollection={createCollection} onRenameCollection={renameCollection} onDeleteCollection={setPendingDelete}
      onDropOnCollection={(cid, ids) => onBulk("add_to_collection", ids, cid)}
      onOpenProject={() => { setDrawer(false); setPage("project"); }} />
  );

  const libraryContent = view.kind === "duplicates" ? (
    <DuplicatesView projectId={project.id} groups={dups.groups} byId={byId} rule={dups.rule} compact={compact}
      onMenu={() => setDrawer(true)} onOpen={setActiveId} onChanged={() => reload(project.id)} />
  ) : (
    <LibraryView refs={viewRefs} view={view} title={viewTitle(view, collections)} collections={collections} compact={compact}
      selected={selected} setSelected={setSelected} activeId={activeId} totalInLibrary={activeRefs.length}
      onOpen={setActiveId} onFavorite={onFavorite} onBulk={onBulk} onExport={onExport}
      onAdd={() => setAddOpen(true)} onMenu={() => setDrawer(true)}
      exportMessage={exportMessage} clearExportMessage={() => setExportMessage(null)} />
  );

  return (
    <div className={`shell${compact ? " shell-compact" : ""}`}>
      {!compact && (
        <nav className="rail" aria-label="Sections">
          <span className="brand-mark rail-brand" title="Evidence-First Research OS" aria-hidden="true">EF</span>
          {PAGES.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`rail-btn${page === id ? " rail-on" : ""}`} onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined} title={label} aria-label={label}>
              <Icon size={22} aria-hidden="true" />
            </button>
          ))}
        </nav>
      )}

      {!compact && page === "library" && sidebar}

      <main className="content">
        {dbState !== "connected" && dbState !== "checking" && (
          <div className="notice notice-warn" role="alert">
            The database is not connected yet, so changes cannot be saved. Live checks still work.
          </div>
        )}
        {error && (
          <div className="notice notice-warn" role="alert">
            {error}
            <button className="btn-ghost btn-sm" onClick={() => reload(project.id)}>Try again</button>
          </div>
        )}
        {pendingDelete && (
          <div className="notice notice-warn confirm-bar" role="alertdialog" aria-label="Delete collection">
            <span>Delete the collection <b>{pendingDelete.name}</b> and its sub-collections? The references stay in your library.</span>
            <button className="btn-danger btn-sm" onClick={confirmDeleteCollection}>Delete collection</button>
            <button className="btn-ghost btn-sm" onClick={() => setPendingDelete(null)}>Cancel</button>
          </div>
        )}

        {page === "library" && libraryContent}
        {page === "list" && <ReferenceListView projectId={project.id} references={activeRefs} />}
        {page === "statement" && <div className="page"><StatementPanel projectId={project.id} refreshKey={refreshKey} /></div>}
        {page === "project" && (
          <div className="page">
            <ProjectPanel key={project.id} project={project} onProject={onProject} onNewProject={newProject} />
            {storedProjects().filter((x) => x.id !== project.id).length > 0 && (
              <section className="panel">
                <h3>Other projects on this device</h3>
                <ul className="project-list">
                  {storedProjects().filter((x) => x.id !== project.id).map((x) => (
                    <li key={x.id}><button className="btn-ghost" onClick={() => switchProject(x.id)}>{x.title}</button></li>
                  ))}
                </ul>
              </section>
            )}
            <Footer />
          </div>
        )}
      </main>

      {page === "library" && active && (
        <DetailPanel projectId={project.id} reference={active} collections={collections} compact={compact}
          onClose={() => setActiveId(null)} onChanged={onDetailChanged} />
      )}

      {compact && drawer && (
        <div className="overlay overlay-drawer" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label="Library menu">
            <button className="icon-btn drawer-close" aria-label="Close menu" onClick={() => setDrawer(false)}><X size={20} /></button>
            {sidebar}
          </div>
        </div>
      )}

      {addOpen && (
        <AddDialog projectId={project.id} collection={currentCollection} onClose={() => setAddOpen(false)}
          onAdded={() => reload(project.id)} />
      )}

      {compact && (
        <nav className="tabs-bottom" aria-label="Sections">
          {PAGES.map(({ id, short, icon: Icon }) => (
            <button key={id} className={page === id ? "btab btab-on" : "btab"} onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}>
              <Icon size={20} aria-hidden="true" />
              <span>{short}</span>
              {id === "library" && counts.all > 0 && <span className="btab-count">{counts.all}</span>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <p>
        All results are live — no sample data. Sources: Crossref (including Retraction Watch data), doi.org, OpenAlex.
        APA 7 style: Citation Style Language project, CC BY-SA 3.0.
      </p>
      <p>AI Club Hackathon 2026 · Nihal Pusthe · Yash Petkar · Siddal · Hemanth</p>
    </footer>
  );
}
