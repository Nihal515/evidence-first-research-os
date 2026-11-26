import {
  ArrowDown, ArrowUp, BookOpenCheck, Download, ExternalLink, FileText, FolderInput, Menu, Plus, RotateCcw, Search,
  SlidersHorizontal, Star, Trash2, X, FolderMinus, ListChecks,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useDismiss } from "../hooks";
import { LABEL_ORDER } from "../labels";
import { EXPORT_LABELS, type ExportFormat } from "../lib/exportActions";
import {
  NO_FILTERS, activeFilterCount, applyFilters, authorShort, collectionTree, flattenTree, sortRefs,
  type Filters, type Sort, type SortKey, type View,
} from "../lib/library";
import type { BulkAction, Collection, Label, Reference } from "../types";
import { TrustLabel, TrustLegend } from "./TrustLabel";

interface Props {
  refs: Reference[];             // references in this view (before search / filters)
  view: View;
  title: string;
  collections: Collection[];
  compact: boolean;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  activeId: string | null;
  totalInLibrary: number;
  onOpen: (id: string) => void;
  onFavorite: (r: Reference) => void;
  onOpenPdf: (r: Reference) => void;
  onBulk: (action: BulkAction, ids: string[], collectionId?: string) => Promise<void>;
  onExport: (format: ExportFormat, refs: Reference[]) => Promise<void>;
  onAdd: () => void;
  onMenu: () => void;
  exportMessage: { ok: boolean; message: string } | null;
  clearExportMessage: () => void;
}

const RETRACTION_CHIP: Record<string, { text: string; cls: string }> = {
  retracted: { text: "Retracted", cls: "chip-red" },
  concern: { text: "Concern", cls: "chip-amber" },
  corrected: { text: "Corrected", cls: "chip-grey" },
};

const COLUMNS: { key: SortKey; label: string; cls: string }[] = [
  { key: "authors", label: "Authors", cls: "col-authors" },
  { key: "year", label: "Year", cls: "col-year" },
  { key: "title", label: "Title", cls: "col-title" },
  { key: "source", label: "Source", cls: "col-source" },
  { key: "trust", label: "Trust", cls: "col-trust" },
  { key: "added", label: "Added", cls: "col-added" },
];

function shortDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function LibraryView(p: Props) {
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<Sort>({ key: "added", dir: "desc" });
  const [menu, setMenu] = useState<"filters" | "export" | "collect" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menu !== null, closeMenu, menuRef);

  const visible = useMemo(() => sortRefs(applyFilters(p.refs, q, filters), sort), [p.refs, q, filters, sort]);
  const selectedVisible = visible.filter((r) => p.selected.has(r.id));
  const selCount = p.selected.size;
  const inTrash = p.view.kind === "trash";
  const inCollection = p.view.kind === "collection" ? p.view.collectionId : undefined;
  // Every reference with a DOI opens its article page on doi.org (the publisher's site);
  // a free legal copy found by OpenAlex is a second link, labelled with its version and host.
  const hasPdfs = p.refs.some((r) => r.doi || r.oa_pdf_url || r.has_uploaded_pdf);
  const doiUrl = (r: Reference) => `https://doi.org/${r.doi}`;
  const freeLink = (r: Reference) => r.oa_pdf_url && r.oa_pdf_url.toLowerCase() !== doiUrl(r).toLowerCase() ? r.oa_pdf_url : null;
  const pdfTitle = (r: Reference) =>
    `Open free ${r.free_copy?.is_pdf ? "PDF" : "copy"}${r.free_copy?.version_text ? ` (${r.free_copy.version_text})` : ""}${r.free_copy?.host ? ` from ${r.free_copy.host}` : ""}`;
  const doiTitle = (r: Reference) => `Open the article page on doi.org (${r.doi})`;
  const nFilters = activeFilterCount(filters);
  const flatCollections = useMemo(() => flattenTree(collectionTree(p.collections)), [p.collections]);

  function toggle(id: string) {
    const s = new Set(p.selected);
    s.has(id) ? s.delete(id) : s.add(id);
    p.setSelected(s);
  }
  function toggleAll() {
    p.setSelected(selectedVisible.length === visible.length ? new Set() : new Set(visible.map((r) => r.id)));
  }
  function setSortKey(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "added" || key === "year" ? "desc" : "asc" }));
  }
  async function bulk(action: BulkAction, collectionId?: string) {
    setBusy(true);
    setMenu(null);
    try {
      await p.onBulk(action, [...p.selected], collectionId);
      if (["trash", "restore", "delete_forever"].includes(action) || (action === "remove_from_collection")) p.setSelected(new Set());
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }
  async function exportAs(format: ExportFormat) {
    setMenu(null);
    const scope = selCount ? p.refs.filter((r) => p.selected.has(r.id)) : visible;
    await p.onExport(format, scope);
  }
  function toggleLabel(l: Label) {
    setFilters((f) => ({ ...f, labels: f.labels.includes(l) ? f.labels.filter((x) => x !== l) : [...f.labels, l] }));
  }

  const showChecks = !p.compact || selectMode || selCount > 0;

  const exportMenu = (
    <div className="menu" role="menu">
      <p className="menu-note">{selCount ? `Exports the ${selCount} selected` : `Exports the ${visible.length} shown`} · Verified only</p>
      {(Object.keys(EXPORT_LABELS) as ExportFormat[]).map((f) => (
        <button key={f} role="menuitem" className="menu-item" onClick={() => exportAs(f)}>{EXPORT_LABELS[f]}</button>
      ))}
    </div>
  );

  return (
    <section className="library" aria-label={p.title}>
      <div className="lib-top" ref={menuRef}>
      {/* ---------------------------------------------------------------- toolbar */}
      <div className="lib-toolbar">
        {p.compact && (
          <button className="icon-btn icon-btn-lg" aria-label="Open library menu" onClick={p.onMenu}><Menu size={22} /></button>
        )}
        <h2 className="lib-title">{p.title} <span className="count">{p.refs.length}</span></h2>
        <div className="lib-search">
          <Search size={16} aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, author, source, notes"
            aria-label="Search your library" />
          {q && <button className="icon-btn" aria-label="Clear search" onClick={() => setQ("")}><X size={14} /></button>}
        </div>
        <div className="tool-group">
          <div className="menu-anchor">
            <button className={`btn-tool${nFilters ? " btn-tool-on" : ""}`} onClick={() => setMenu(menu === "filters" ? null : "filters")} aria-label="Filters" title="Filters"
              aria-expanded={menu === "filters"}>
              <SlidersHorizontal size={16} aria-hidden="true" /> <span className="tool-text">Filters</span>{nFilters ? ` (${nFilters})` : ""}
            </button>
            {menu === "filters" && (
              <div className="menu menu-wide" role="dialog" aria-label="Filters">
                <p className="menu-head">Trust label</p>
                {LABEL_ORDER.map((l) => (
                  <label key={l} className="menu-check">
                    <input type="checkbox" checked={filters.labels.includes(l)} onChange={() => toggleLabel(l)} />
                    <TrustLabel label={l} size="sm" />
                  </label>
                ))}
                <p className="menu-head">Retraction</p>
                <label className="menu-check">
                  <input type="checkbox" checked={filters.retractedOnly}
                    onChange={(e) => setFilters({ ...filters, retractedOnly: e.target.checked })} />
                  Retracted or expression of concern
                </label>
                <p className="menu-head">Year</p>
                <div className="menu-years">
                  <input inputMode="numeric" maxLength={4} placeholder="From" aria-label="Year from"
                    value={filters.yearFrom ?? ""} onChange={(e) => setFilters({ ...filters, yearFrom: Number(e.target.value) || null })} />
                  <span>–</span>
                  <input inputMode="numeric" maxLength={4} placeholder="To" aria-label="Year to"
                    value={filters.yearTo ?? ""} onChange={(e) => setFilters({ ...filters, yearTo: Number(e.target.value) || null })} />
                </div>
                <label className="menu-check">
                  <input type="checkbox" checked={filters.unreadOnly}
                    onChange={(e) => setFilters({ ...filters, unreadOnly: e.target.checked })} />
                  Unread only
                </label>
                <div className="menu-foot">
                  <button className="btn-ghost" onClick={() => setFilters(NO_FILTERS)} disabled={!nFilters}>Clear filters</button>
                </div>
              </div>
            )}
          </div>
          {!inTrash && (
            <div className="menu-anchor">
              <button className="btn-tool" onClick={() => setMenu(menu === "export" ? null : "export")} aria-expanded={menu === "export"} aria-label="Export" title="Export">
                <Download size={16} aria-hidden="true" /> <span className="tool-text">Export</span>
              </button>
              {menu === "export" && selCount === 0 && exportMenu}
            </div>
          )}
          {p.compact && (
            <button className={`btn-tool${selectMode ? " btn-tool-on" : ""}`} aria-pressed={selectMode} aria-label="Select" title="Select"
              onClick={() => { setSelectMode(!selectMode); if (selectMode) p.setSelected(new Set()); }}>
              <ListChecks size={16} aria-hidden="true" /> <span className="tool-text">Select</span>
            </button>
          )}
          {p.compact && (
            <button className="btn-primary btn-sm" onClick={p.onAdd} aria-label="Add references"><Plus size={18} /> Add</button>
          )}
        </div>
      </div>

      <TrustLegend />

      {p.exportMessage && (
        <div className={`notice ${p.exportMessage.ok ? "notice-ok" : "notice-warn"}`} role="status">
          {p.exportMessage.message}
          <button className="icon-btn" aria-label="Dismiss" onClick={p.clearExportMessage}><X size={14} /></button>
        </div>
      )}

      {/* ---------------------------------------------------------------- bulk bar */}
      {selCount > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Selected references">
          <span className="bulk-count">{selCount} selected</span>
          {inTrash ? (
            <>
              <button className="btn-tool" onClick={() => bulk("restore")} disabled={busy}><RotateCcw size={16} /> Restore</button>
              {confirmDelete ? (
                <>
                  <span className="bulk-warn">Delete {selCount} for good? This cannot be undone.</span>
                  <button className="btn-danger btn-sm" onClick={() => bulk("delete_forever")} disabled={busy}>Delete forever</button>
                  <button className="btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn-tool btn-tool-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={16} /> Delete forever</button>
              )}
            </>
          ) : (
            <>
              <div className="menu-anchor">
                <button className="btn-tool" onClick={() => setMenu(menu === "collect" ? null : "collect")} disabled={busy} aria-label="Add to collection" title="Add to collection">
                  <FolderInput size={16} /> <span className="tool-text">Add to collection</span>
                </button>
                {menu === "collect" && (
                  <div className="menu" role="menu">
                    {!flatCollections.length && <p className="menu-note">No collections yet — create one in the sidebar.</p>}
                    {flatCollections.map((c) => (
                      <button key={c.id} role="menuitem" className="menu-item" style={{ paddingLeft: 12 + c.depth * 14 }}
                        onClick={() => bulk("add_to_collection", c.id)}>{c.name}</button>
                    ))}
                  </div>
                )}
              </div>
              {inCollection && (
                <button className="btn-tool" onClick={() => bulk("remove_from_collection", inCollection)} disabled={busy} aria-label="Remove from collection" title="Remove from collection">
                  <FolderMinus size={16} /> <span className="tool-text">Remove from collection</span>
                </button>
              )}
              <button className="btn-tool" onClick={() => bulk("favorite")} disabled={busy} aria-label="Favourite" title="Favourite"><Star size={16} /> <span className="tool-text">Favourite</span></button>
              <button className="btn-tool" onClick={() => bulk("mark_read")} disabled={busy} aria-label="Mark read" title="Mark read"><BookOpenCheck size={16} /> <span className="tool-text">Mark read</span></button>
              <div className="menu-anchor">
                <button className="btn-tool" onClick={() => setMenu(menu === "export" ? null : "export")} aria-label="Export selected" title="Export selected"><Download size={16} /> <span className="tool-text">Export</span></button>
                {menu === "export" && exportMenu}
              </div>
              <button className="btn-tool btn-tool-danger" onClick={() => bulk("trash")} disabled={busy} aria-label="Move to Trash" title="Move to Trash"><Trash2 size={16} /> <span className="tool-text">Move to Trash</span></button>
            </>
          )}
          <button className="btn-ghost btn-sm" onClick={() => p.setSelected(new Set())}>Clear</button>
        </div>
      )}
      </div>

      {/* ---------------------------------------------------------------- empty states */}
      {p.totalInLibrary === 0 && !inTrash ? (
        <div className="empty-state">
          <h3>Your library is empty</h3>
          <p>Add references by searching scholarly databases, checking a reference (for example one an AI gave you), or
            importing a BibTeX / RIS file from another reference manager. Every source is checked live before you approve it.</p>
          <button className="btn-primary" onClick={p.onAdd}><Plus size={18} /> Add references</button>
        </div>
      ) : visible.length === 0 ? (
        <p className="empty">
          {p.refs.length === 0
            ? inTrash ? "Trash is empty." : "Nothing here yet."
            : "No references match your search or filters."}
        </p>
      ) : p.compact ? (
        /* ---------------------------------------------------------------- phone: cards */
        <ul className="ref-cards">
          {visible.map((r) => {
            const rc = RETRACTION_CHIP[r.retraction?.status ?? ""];
            return (
              <li key={r.id} className={`ref-card${p.selected.has(r.id) ? " ref-sel" : ""}`}>
                {showChecks && (
                  <input type="checkbox" className="card-check" checked={p.selected.has(r.id)} onChange={() => toggle(r.id)}
                    aria-label={`Select ${r.title}`} />
                )}
                <button className="ref-card-main" onClick={() => p.onOpen(r.id)}>
                  <span className="ref-card-labels">
                    <TrustLabel label={r.label} size="sm" />
                    {rc && <span className={`chip ${rc.cls}`}>{rc.text}</span>}
                    {!r.read_at && !inTrash && <span className="unread-dot" title="Unread" aria-label="Unread" />}
                  </span>
                  <span className="ref-card-title">{r.title}</span>
                  <span className="ref-card-meta">{authorShort(r.authors)}{r.year ? ` · ${r.year}` : ""}{r.container ? ` · ${r.container}` : ""}</span>
                </button>
                {r.doi && !inTrash && (
                  <a className="icon-btn pdf-on card-pdf" href={doiUrl(r)} target="_blank" rel="noopener noreferrer"
                    title={doiTitle(r)} aria-label={doiTitle(r)} onClick={() => p.onOpenPdf(r)}>
                    <ExternalLink size={18} />
                  </a>
                )}
                {freeLink(r) && !inTrash && (
                  <a className="icon-btn pdf-on card-pdf" href={freeLink(r)!} target="_blank" rel="noopener noreferrer"
                    title={pdfTitle(r)} aria-label={pdfTitle(r)} onClick={() => p.onOpenPdf(r)}>
                    <FileText size={18} />
                  </a>
                )}
                {!inTrash && (
                  <button className={`icon-btn star${r.favorite ? " star-on" : ""}`} aria-pressed={r.favorite}
                    aria-label={r.favorite ? "Remove from favourites" : "Add to favourites"} onClick={() => p.onFavorite(r)}>
                    <Star size={18} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        /* ---------------------------------------------------------------- desktop: table */
        <div className="table-wrap">
          <table className={`ref-table${p.activeId ? " ref-table-narrow" : ""}`}>
            <thead>
              <tr>
                <th className="col-check">
                  <input type="checkbox" aria-label="Select all shown" checked={visible.length > 0 && selectedVisible.length === visible.length}
                    ref={(el) => { if (el) el.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visible.length; }}
                    onChange={toggleAll} />
                </th>
                <th className="col-star" aria-label="Favourite" />
                <th className="col-dot" aria-label="Unread" />
                {COLUMNS.map((c) => (
                  <th key={c.key} className={c.cls} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button className="th-sort" onClick={() => setSortKey(c.key)}>
                      {c.label}
                      {sort.key === c.key && (sort.dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                    </button>
                  </th>
                ))}
                {hasPdfs && <th className="col-pdf">Open</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const rc = RETRACTION_CHIP[r.retraction?.status ?? ""];
                const sel = p.selected.has(r.id);
                return (
                  <tr key={r.id} className={`${sel ? "row-sel" : ""}${p.activeId === r.id ? " row-active" : ""}`}
                    onClick={() => p.onOpen(r.id)} draggable={!inTrash}
                    onDragStart={(e) => {
                      const ids = sel ? [...p.selected] : [r.id];
                      e.dataTransfer.setData("application/x-efro-refs", JSON.stringify(ids));
                      e.dataTransfer.effectAllowed = "copy";
                    }}>
                    <td className="col-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel} onChange={() => toggle(r.id)} aria-label={`Select ${r.title}`} />
                    </td>
                    <td className="col-star" onClick={(e) => e.stopPropagation()}>
                      {!inTrash && (
                        <button className={`icon-btn star${r.favorite ? " star-on" : ""}`} aria-pressed={r.favorite}
                          aria-label={r.favorite ? "Remove from favourites" : "Add to favourites"} onClick={() => p.onFavorite(r)}>
                          <Star size={16} />
                        </button>
                      )}
                    </td>
                    <td className="col-dot">{!r.read_at && !inTrash && <span className="unread-dot" title="Unread" aria-label="Unread" />}</td>
                    <td className="col-authors" title={r.authors.join("; ")}>{authorShort(r.authors)}</td>
                    <td className="col-year">{r.year ?? ""}</td>
                    <td className="col-title" title={r.title}>
                      {rc && <span className={`chip ${rc.cls}`}>{rc.text}</span>}
                      {r.title}
                    </td>
                    <td className="col-source" title={r.container}>{r.container}</td>
                    <td className="col-trust"><TrustLabel label={r.label} size="sm" /></td>
                    <td className="col-added">{shortDate(inTrash && r.deleted_at ? r.deleted_at : r.approved_at)}</td>
                    {hasPdfs && (
                      <td className="col-pdf" onClick={(e) => e.stopPropagation()}>
                        {r.doi && (
                          <a className="icon-btn pdf-on" href={doiUrl(r)} target="_blank" rel="noopener noreferrer"
                            title={doiTitle(r)} aria-label={doiTitle(r)} onClick={() => p.onOpenPdf(r)}>
                            <ExternalLink size={16} />
                          </a>
                        )}
                        {freeLink(r) && (
                          <a className="icon-btn pdf-on" href={freeLink(r)!} target="_blank" rel="noopener noreferrer"
                            title={pdfTitle(r)} aria-label={pdfTitle(r)} onClick={() => p.onOpenPdf(r)}>
                            <FileText size={16} />
                          </a>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {visible.length > 0 && (
        <p className="lib-foot">
          Showing {visible.length} of {p.refs.length}
          {inTrash ? " · References in Trash are not exported and not counted in your AI-use statement." : ""}
          {!p.compact && !inTrash ? " · Drag rows onto a collection to file them." : ""}
        </p>
      )}
    </section>
  );
}
