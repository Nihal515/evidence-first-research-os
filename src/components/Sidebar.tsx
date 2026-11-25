import {
  ChevronDown, ChevronRight, Clock, Copy, Folder, FolderPlus, Inbox, Library, Pencil, Plus, Star, Trash2,
  TriangleAlert, BookOpenCheck, X, Check,
} from "lucide-react";
import { useMemo, useState } from "react";
import { collectionTree, type CollectionNode, type View } from "../lib/library";
import type { Collection, Project } from "../types";

interface Props {
  project: Project;
  view: View;
  counts: Record<string, number>;
  collections: Collection[];
  onView: (v: View) => void;
  onAdd: () => void;
  onCreateCollection: (name: string, parentId: string | null) => Promise<boolean>;
  onRenameCollection: (id: string, name: string) => Promise<boolean>;
  onDeleteCollection: (c: Collection) => void;
  onDropOnCollection: (collectionId: string, ids: string[]) => void;
  onOpenProject: () => void;
}

const LIBRARY_VIEWS = [
  { kind: "all", label: "All references", icon: Library },
  { kind: "recent", label: "Recently added", icon: Clock },
  { kind: "read", label: "Recently read", icon: BookOpenCheck },
  { kind: "favorites", label: "Favourites", icon: Star },
  { kind: "unsorted", label: "Unsorted", icon: Inbox },
  { kind: "attention", label: "Needs attention", icon: TriangleAlert },
  { kind: "duplicates", label: "Duplicates", icon: Copy },
  { kind: "trash", label: "Trash", icon: Trash2 },
] as const;

function same(a: View, b: View) {
  return a.kind === b.kind && (a.kind !== "collection" || a.collectionId === b.collectionId);
}

export function Sidebar(p: Props) {
  const tree = useMemo(() => collectionTree(p.collections), [p.collections]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState<{ parent: string | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return setCreating(null);
    setError("");
    if (await p.onCreateCollection(draft.trim(), creating?.parent ?? null)) {
      if (creating?.parent) setCollapsed((c) => ({ ...c, [creating.parent!]: false }));
      setCreating(null);
      setDraft("");
    } else setError("That name is already used here.");
  }

  async function submitRename(e: React.FormEvent, id: string) {
    e.preventDefault();
    if (draft.trim() && (await p.onRenameCollection(id, draft.trim()))) {
      setRenaming(null);
      setDraft("");
    }
  }

  const newForm = (parent: string | null, depth: number) => (
    <form className="side-form" style={{ paddingLeft: 12 + depth * 16 }} onSubmit={submitCreate}>
      <Folder size={16} aria-hidden="true" />
      <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={120}
        placeholder="Collection name" aria-label="New collection name"
        onKeyDown={(e) => e.key === "Escape" && setCreating(null)} />
      <button className="icon-btn" aria-label="Create collection"><Check size={16} /></button>
      <button type="button" className="icon-btn" aria-label="Cancel" onClick={() => setCreating(null)}><X size={16} /></button>
    </form>
  );

  const renderNode = (n: CollectionNode) => {
    const v: View = { kind: "collection", collectionId: n.id };
    const open = !collapsed[n.id];
    return (
      <li key={n.id}>
        {renaming === n.id ? (
          <form className="side-form" style={{ paddingLeft: 12 + n.depth * 16 }} onSubmit={(e) => submitRename(e, n.id)}>
            <Folder size={16} aria-hidden="true" />
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={120}
              aria-label="Collection name" onKeyDown={(e) => e.key === "Escape" && setRenaming(null)} />
            <button className="icon-btn" aria-label="Save name"><Check size={16} /></button>
          </form>
        ) : (
          <div className={`side-item side-coll${same(p.view, v) ? " side-on" : ""}${dropTarget === n.id ? " side-drop" : ""}`}
            style={{ paddingLeft: 6 + n.depth * 16 }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-efro-refs")) { e.preventDefault(); setDropTarget(n.id); } }}
            onDragLeave={() => setDropTarget((t) => (t === n.id ? null : t))}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              try {
                const ids = JSON.parse(e.dataTransfer.getData("application/x-efro-refs"));
                if (Array.isArray(ids) && ids.length) p.onDropOnCollection(n.id, ids);
              } catch { /* not ours */ }
            }}>
            <button className="icon-btn twisty" aria-label={open ? "Collapse" : "Expand"}
              style={{ visibility: n.children.length ? "visible" : "hidden" }}
              onClick={() => setCollapsed((c) => ({ ...c, [n.id]: open }))}>
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <button className="side-link" onClick={() => p.onView(v)} aria-current={same(p.view, v) ? "page" : undefined}>
              <Folder size={16} aria-hidden="true" />
              <span className="side-text">{n.name}</span>
              <span className="side-count">{p.counts[`c:${n.id}`] || ""}</span>
            </button>
            <span className="side-tools">
              <button className="icon-btn" title="New sub-collection" aria-label={`New collection inside ${n.name}`}
                onClick={() => { setCreating({ parent: n.id }); setDraft(""); }}><Plus size={14} /></button>
              <button className="icon-btn" title="Rename" aria-label={`Rename ${n.name}`}
                onClick={() => { setRenaming(n.id); setDraft(n.name); }}><Pencil size={14} /></button>
              <button className="icon-btn" title="Delete collection" aria-label={`Delete ${n.name}`}
                onClick={() => p.onDeleteCollection(n)}><Trash2 size={14} /></button>
            </span>
          </div>
        )}
        {open && (n.children.length > 0 || creating?.parent === n.id) && (
          <ul className="side-list">
            {n.children.map(renderNode)}
            {creating?.parent === n.id && <li>{newForm(n.id, n.depth + 1)}</li>}
          </ul>
        )}
      </li>
    );
  };

  return (
    <aside className="sidebar" aria-label="Library">
      <button className="btn-primary btn-add" onClick={p.onAdd}><Plus size={18} aria-hidden="true" /> Add references</button>

      <nav aria-label="Library views">
        <ul className="side-list">
          {LIBRARY_VIEWS.map(({ kind, label, icon: Icon }) => {
            const v: View = { kind };
            const n = p.counts[kind] || 0;
            return (
              <li key={kind}>
                <button className={`side-item side-link-row${same(p.view, v) ? " side-on" : ""}`} onClick={() => p.onView(v)}
                  aria-current={same(p.view, v) ? "page" : undefined}>
                  <Icon size={16} aria-hidden="true" />
                  <span className="side-text">{label}</span>
                  <span className={`side-count${kind === "attention" && n ? " side-count-warn" : ""}`}>{n || ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="side-head">
        <span>Collections</span>
        <button className="icon-btn" aria-label="New collection" title="New collection"
          onClick={() => { setCreating({ parent: null }); setDraft(""); }}><FolderPlus size={16} /></button>
      </div>
      <ul className="side-list side-colls">
        {tree.map(renderNode)}
        {creating?.parent === null && <li>{newForm(null, 0)}</li>}
        {!tree.length && !creating && (
          <li>
            <button className="side-empty" onClick={() => { setCreating({ parent: null }); setDraft(""); }}>
              <Plus size={14} aria-hidden="true" /> Create a collection
            </button>
          </li>
        )}
      </ul>
      {error && <p className="error small side-error" role="alert">{error}</p>}

      <button className="side-project" onClick={p.onOpenProject} title="Project settings">
        <span className="side-project-label">Project</span>
        <span className="side-project-title">{p.project.title}</span>
      </button>
    </aside>
  );
}
