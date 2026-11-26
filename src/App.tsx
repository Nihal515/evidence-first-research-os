import { BookOpenCheck, CircleUser, FlaskConical, FolderCog, Library, LogIn, LogOut, Moon, MoreHorizontal, PlayCircle, Quote, ScrollText, ShieldCheck, Sun, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { onAuthChange, restoreSession, signOut } from "./auth";
import { AddDialog } from "./components/AddDialog";
import { DetailPanel } from "./components/DetailPanel";
import { AiDial } from "./components/AiAgents";
import { DuplicatesView } from "./components/DuplicatesView";
import { GuidePage, RulesPage } from "./components/InfoPages";
import { LabPage } from "./components/LabPage";
import { LibraryView } from "./components/LibraryView";
import { LoginPage } from "./components/LoginPage";
import { ProjectPanel } from "./components/ProjectPanel";
import { ReferenceListView } from "./components/ReferenceListView";
import { Sidebar } from "./components/Sidebar";
import { StatementPanel } from "./components/StatementPanel";
import { startTour } from "./components/Tour";
import { HANDOFF } from "./landing/data";
import { go, Link } from "./router";
import { COMPACT_QUERY, useMedia } from "./hooks";
import { runExport, type ExportFormat } from "./lib/exportActions";
import { refsForView, viewCounts, viewTitle, type View } from "./lib/library";
import type { BulkAction, Collection, Project, Reference } from "./types";

type Page = "library" | "list" | "statement" | "project" | InfoPage;
type InfoPage = "guide" | "lab" | "rules";
const INFO: { id: InfoPage; label: string; path: string; icon: typeof Library }[] = [
  { id: "guide", label: "How it works", path: "/guide", icon: BookOpenCheck },
  { id: "lab", label: "Integrity Lab", path: "/lab", icon: FlaskConical },
  { id: "rules", label: "House rules", path: "/rules", icon: ScrollText },
];
const isInfo = (p: Page): p is InfoPage => p === "guide" || p === "lab" || p === "rules";
const ROUTE_PAGE: Record<string, Page> = { "/projects": "project", "/guide": "guide", "/lab": "lab", "/rules": "rules" };
const THEME_KEY = "pt.theme";
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

export default function App({ route = "/home" }: { route?: string }) {
  const compact = useMedia(COMPACT_QUERY);
  const [project, setProject] = useState<Project | null>(null);
  const [refs, setRefs] = useState<Reference[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [dups, setDups] = useState<{ groups: string[][]; rule: string }>({ groups: [], rule: "" });
  const [page, setPageState] = useState<Page>(() => ROUTE_PAGE[route] ?? "library");
  const [moreOpen, setMoreOpen] = useState(false);
  const [dark, setDark] = useState(() => storage(() => localStorage.getItem(THEME_KEY) === "dark", false));
  // /check opens the Add dialog: on Import with a handed-over list, otherwise on Check
  const [checkOpen, setCheckOpen] = useState<{ tab: "check" | "import"; text: string } | null>(null);
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
  const [account, setAccount] = useState<Me["user"]>(null);
  const [authConfigured, setAuthConfigured] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [claimOffer, setClaimOffer] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [accountProjects, setAccountProjects] = useState<Project[]>([]);

  const setPage = useCallback((p: Page) => {
    setPageState(p);
    setMoreOpen(false);
    const path = isInfo(p) ? INFO.find((x) => x.id === p)!.path : p === "project" ? "/projects" : "/home";
    if (window.location.pathname !== path) go(path);
  }, []);

  // follow the address bar (links, Back and Forward)
  useEffect(() => {
    if (ROUTE_PAGE[route]) setPageState(ROUTE_PAGE[route]);
    else setPageState((cur) => (isInfo(cur) || cur === "project" ? "library" : cur));
    if (route === "/check") {
      const text = storage(() => sessionStorage.getItem(HANDOFF) || "", "");
      storage(() => sessionStorage.removeItem(HANDOFF), undefined);
      setCheckOpen({ tab: text ? "import" : "check", text });
    }
  }, [route]);

  // Lights off: dark theme for the workspace, remembered on this device
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    storage(() => localStorage.setItem(THEME_KEY, dark ? "dark" : "light"), undefined);
  }, [dark]);

  useEffect(() => {
    document.title = "Paper Trail";
  }, []);

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

  const openProject = useCallback(async (p: Project) => {
    setProject(p);
    storeId(p.id);
    if (!p.owned) rememberProject(p);
    await reload(p.id);
  }, [reload]);

  /** Who is signed in, and which project to show. */
  const resolve = useCallback(async () => {
    let me: Me | null = null;
    try {
      me = await api.me();
    } catch {
      me = null;
    }
    setAccount(me?.user ?? null);
    setAuthConfigured(Boolean(me?.auth_configured));
    if (me?.user) setAccountProjects(await api.myProjects().catch(() => []));
    const id = storedId();
    if (id) {
      try {
        await openProject(await api.getProject(id));
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          storeId(null);
          forgetProject(id);
        } else {
          setError(err instanceof ApiError ? err.message : "Could not load your project.");
          return;
        }
      }
    }
    if (me?.user) {
      const mine = await api.myProjects().catch(() => [] as Project[]);
      if (mine.length) await openProject(mine[0]);
    }
  }, [openProject]);

  useEffect(() => {
    api.health().then((h) => setDbState(h.database)).catch(() => setDbState("error"));
    restoreSession()
      .catch(() => false)
      .then(() => resolve())
      .finally(() => setLoading(false));
    // if the session ends (signed out elsewhere, expired), fall back to guest mode
    return onAuthChange(() => {
      api.me().then((me) => setAccount(me.user)).catch(() => setAccount(null));
    });
  }, [resolve]);

  async function afterSignIn() {
    setShowLogin(false);
    setAccountMenu(false);
    setPage("library");
    const me = await api.me().catch(() => null);
    setAccount(me?.user ?? null);
    setAccountProjects(await api.myProjects().catch(() => []));
    if (project && !project.owned) setClaimOffer(true); // offer to save the guest library to the account
    else if (!project) await resolve();
  }

  async function doSignOut() {
    setAccountMenu(false);
    await signOut().catch(() => undefined);
    setAccount(null);
    setAccountProjects([]);
    setClaimOffer(false);
    if (project?.owned) {
      // an account's library is private: leave it when signing out
      storeId(null);
      setProject(null);
      setRefs([]);
      setCollections([]);
      setActiveId(null);
      setPage("library");
    }
  }

  async function claim() {
    if (!project) return;
    try {
      const p = await api.claim(project.id);
      setProject(p);
      forgetProject(p.id);
      setClaimOffer(false);
      setAccountProjects(await api.myProjects().catch(() => []));
      setExportMessage({ ok: true, message: `“${p.title}” is now saved to your account.` });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the library to your account.");
    }
  }

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
    if (!p.owned) rememberProject(p);
    if (account) api.myProjects().then(setAccountProjects).catch(() => undefined);
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

  function onOpenPdf(r: Reference) {
    // opening the free copy counts as reading it, as in other reference managers
    if (!project || r.read_at) return;
    api.patch(project.id, r.id, { read: true }).then(() => reload(project.id)).catch(() => undefined);
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

  const moreItems = (
    <>
      {INFO.map(({ id, label, icon: Icon }) => (
        <button key={id} className={`menu-item${page === id ? " menu-item-on" : ""}`} role="menuitem" onClick={() => setPage(id)}>
          <Icon size={16} aria-hidden="true" /> {label}
        </button>
      ))}
      <button className="menu-item" role="menuitem" onClick={() => { setMoreOpen(false); startTour(); }}>
        <PlayCircle size={16} aria-hidden="true" /> Take the tour
      </button>
      <button className="menu-item" role="menuitemcheckbox" aria-checked={dark} onClick={() => { setDark(!dark); setMoreOpen(false); }}>
        {dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />} {dark ? "Lights on" : "Lights off"}
      </button>
      <Link to="/" className="menu-item" role="menuitem" onClick={() => setMoreOpen(false)}>
        <span className="pt-mini" aria-hidden="true">PT</span> Paper Trail home
      </Link>
    </>
  );
  const infoContent = page === "guide" ? <GuidePage /> : page === "lab" ? <LabPage /> : page === "rules" ? <RulesPage /> : null;

  // ---------------------------------------------------------------- start screen
  if (loading) return <p className="empty boot">Loading…</p>;

  if (showLogin) {
    return <LoginPage configured={authConfigured} onDone={afterSignIn} onGuest={() => setShowLogin(false)} />;
  }

  if (!project && isInfo(page)) {
    return (
      <div className="welcome">
        <div className="welcome-top">
          <Link to="/" className="welcome-brand brand-link">
            <span className="brand-mark" aria-hidden="true">PT</span>
            <div>
              <h1>Paper Trail</h1>
              <p className="tagline">Find, check, organise and cite sources honestly</p>
            </div>
          </Link>
          <div className="actions">
            {INFO.filter((x) => x.id !== page).map((x) => (
              <button key={x.id} className="btn-ghost btn-sm" onClick={() => setPage(x.id)}>{x.label}</button>
            ))}
            <button className="btn-primary btn-sm" onClick={() => setPage("library")}>Open workspace</button>
          </div>
        </div>
        {infoContent}
      </div>
    );
  }

  if (!project) {
    const others = storedProjects();
    return (
      <div className="welcome">
        <div className="welcome-top">
          <Link to="/" className="welcome-brand brand-link">
            <span className="brand-mark" aria-hidden="true">PT</span>
            <div>
              <h1>Paper Trail</h1>
              <p className="tagline">Find, check, organise and cite sources honestly</p>
            </div>
          </Link>
          {account ? (
            <button className="btn-ghost btn-sm" onClick={doSignOut} title={account.email}><LogOut size={14} /> Sign out</button>
          ) : (
            <button className="btn-secondary btn-sm" onClick={() => setShowLogin(true)}><LogIn size={14} /> Sign in</button>
          )}
        </div>
        {account && <p className="notice notice-ok" role="status">Signed in as {account.email}. New projects are saved to your account.</p>}
        {checkOpen && <p className="notice notice-ok" role="status">Start a research project first. Your {checkOpen.text ? "list" : "check"} opens as soon as it is created.</p>}
        {dbState !== "connected" && dbState !== "checking" && (
          <div className="notice notice-warn" role="alert">The database is not connected, so projects cannot be saved yet.</div>
        )}
        {error && <div className="notice notice-warn" role="alert">{error}</div>}
        <ProjectPanel project={null} onProject={onProject} onNewProject={newProject} />
        <nav className="welcome-links" aria-label="About Paper Trail">
          {INFO.map((x) => <button key={x.id} className="btn-ghost btn-sm" onClick={() => setPage(x.id)}>{x.label}</button>)}
          <button className="btn-ghost btn-sm" onClick={startTour}>Take the tour</button>
          <button className="btn-ghost btn-sm" onClick={() => setDark(!dark)}>{dark ? "Lights on" : "Lights off"}</button>
        </nav>
        {accountProjects.length > 0 && (
          <section className="panel">
            <h3>Your account’s projects</h3>
            <ul className="project-list">
              {accountProjects.map((x) => <li key={x.id}><button className="btn-ghost" onClick={() => switchProject(x.id)}>{x.title}</button></li>)}
            </ul>
          </section>
        )}
        {others.length > 0 && (
          <section className="panel">
            <h3>Guest projects on this device</h3>
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
      onOpen={setActiveId} onFavorite={onFavorite} onBulk={onBulk} onExport={onExport} onOpenPdf={onOpenPdf}
      onAdd={() => setAddOpen(true)} onMenu={() => setDrawer(true)}
      exportMessage={exportMessage} clearExportMessage={() => setExportMessage(null)} />
  );

  return (
    <div className={`shell${compact ? " shell-compact" : ""}`}>
      {!compact && (
        <nav className="rail" aria-label="Sections">
          <Link to="/" className="brand-mark rail-brand" title="Paper Trail home" aria-label="Paper Trail home">PT</Link>
          {PAGES.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`rail-btn${page === id ? " rail-on" : ""}`} onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined} title={label} aria-label={label}>
              <Icon size={22} aria-hidden="true" />
            </button>
          ))}
          <div className="rail-more">
            <button className={`rail-btn${isInfo(page) ? " rail-on" : ""}`} onClick={() => { setMoreOpen(!moreOpen); setAccountMenu(false); }}
              title="More" aria-label="More" aria-haspopup="menu" aria-expanded={moreOpen}>
              <MoreHorizontal size={22} aria-hidden="true" />
            </button>
            {moreOpen && <div className="menu account-menu more-menu" role="menu" aria-label="More">{moreItems}</div>}
          </div>
          <div className="rail-account">
            <button className={`rail-btn${account ? " rail-signed" : ""}`} onClick={() => { setMoreOpen(false); if (account) setAccountMenu(!accountMenu); else setShowLogin(true); }}
              title={account ? `Signed in as ${account.email}` : "Sign in"} aria-label={account ? "Account" : "Sign in"} aria-expanded={account ? accountMenu : undefined}>
              {account ? <span className="avatar">{(account.name || account.email).slice(0, 1).toUpperCase()}</span> : <LogIn size={22} aria-hidden="true" />}
            </button>
            {account && accountMenu && (
              <div className="menu account-menu" role="menu">
                <p className="menu-note">Signed in as<br /><b>{account.email}</b></p>
                <button className="menu-item" role="menuitem" onClick={() => { setAccountMenu(false); setPage("project"); }}>Your projects</button>
                <button className="menu-item" role="menuitem" onClick={doSignOut}><LogOut size={14} /> Sign out</button>
              </div>
            )}
          </div>
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
        {page !== "library" && exportMessage && (
          <div className={`notice ${exportMessage.ok ? "notice-ok" : "notice-warn"}`} role="status">
            {exportMessage.message}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setExportMessage(null)}><X size={14} /></button>
          </div>
        )}
        {claimOffer && project && !project.owned && account && (
          <div className="notice notice-ok confirm-bar" role="status">
            <span>Signed in as <b>{account.email}</b>. Save “{project.title}” to your account, so it is private and on all your devices?</span>
            <button className="btn-primary btn-sm" onClick={claim}>Save to my account</button>
            <button className="btn-ghost btn-sm" onClick={() => setClaimOffer(false)}>Not now</button>
          </div>
        )}
        {pendingDelete && (
          <div className="notice notice-warn confirm-bar" role="alertdialog" aria-label="Delete collection">
            <span>Delete the collection <b>{pendingDelete.name}</b> and its sub-collections? The references stay in your library.</span>
            <button className="btn-danger btn-sm" onClick={confirmDeleteCollection}>Delete collection</button>
            <button className="btn-ghost btn-sm" onClick={() => setPendingDelete(null)}>Cancel</button>
          </div>
        )}

        {infoContent}
        {page === "library" && libraryContent}
        {page === "list" && <ReferenceListView projectId={project.id} references={activeRefs} />}
        {page === "statement" && <div className="page"><StatementPanel projectId={project.id} refreshKey={refreshKey} /></div>}
        {page === "project" && (
          <div className="page">
            <section className="panel account-panel">
              <h3><CircleUser size={18} aria-hidden="true" /> Account</h3>
              {account ? (
                <>
                  <p className="hint">Signed in as <b>{account.email}</b>.{" "}
                    {project.owned_by_you ? "This project is saved to your account." : "This project is a guest project on this device."}</p>
                  <div className="actions">
                    {!project.owned && <button className="btn-primary btn-sm" onClick={claim}>Save this project to my account</button>}
                    <button className="btn-ghost btn-sm" onClick={doSignOut}><LogOut size={14} /> Sign out</button>
                  </div>
                  {accountProjects.filter((x) => x.id !== project.id).length > 0 && (
                    <>
                      <p className="sub-title">Your account’s other projects</p>
                      <ul className="project-list">
                        {accountProjects.filter((x) => x.id !== project.id).map((x) => (
                          <li key={x.id}><button className="btn-ghost" onClick={() => switchProject(x.id)}>{x.title}</button></li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <>
                  <p className="hint">You are using a guest library on this device. Sign in to keep it private and use it on every device.</p>
                  <div className="actions"><button className="btn-secondary btn-sm" onClick={() => setShowLogin(true)}><LogIn size={14} /> Sign in or create an account</button></div>
                </>
              )}
            </section>
            <AiDial project={project} onProject={onProject} />
            <ProjectPanel key={project.id} project={project} onProject={onProject} onNewProject={newProject} />
            {storedProjects().filter((x) => x.id !== project.id).length > 0 && (
              <section className="panel">
                <h3>Guest projects on this device</h3>
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
          aiLevel={project.ai_level} onClose={() => setActiveId(null)} onChanged={onDetailChanged} />
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
          aiLevel={project.ai_level} onAdded={() => reload(project.id)} />
      )}
      {checkOpen && !addOpen && (
        <AddDialog projectId={project.id} collection={currentCollection} initialTab={checkOpen.tab} initialText={checkOpen.text}
          aiLevel={project.ai_level}
          onClose={() => { setCheckOpen(null); if (window.location.pathname === "/check") go("/home"); }}
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
          <button className={isInfo(page) || moreOpen ? "btab btab-on" : "btab"} onClick={() => setMoreOpen(!moreOpen)}
            aria-haspopup="menu" aria-expanded={moreOpen}>
            <MoreHorizontal size={20} aria-hidden="true" />
            <span>More</span>
          </button>
        </nav>
      )}
      {compact && moreOpen && (
        <div className="overlay overlay-sheet" onMouseDown={(e) => e.target === e.currentTarget && setMoreOpen(false)}>
          <div className="menu more-sheet" role="menu" aria-label="More">{moreItems}</div>
        </div>
      )}
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <p>
        Paper Trail. All results are live — no sample data. Sources: Crossref (including Retraction Watch data), doi.org, OpenAlex.
        APA 7 style: Citation Style Language project, CC BY-SA 3.0.
      </p>
      <p>Team 1 · SP Jain AI Club Hackathon 2026 · Nihal Pusthe · Yash Petkar · Siddal · Hemanth</p>
    </footer>
  );
}
