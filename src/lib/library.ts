// Library views, search, filters and sorting. Plain code, no AI.
import type { Collection, Label, Reference } from "../types";

export type ViewKind =
  | "all" | "recent" | "read" | "favorites" | "unsorted" | "attention" | "duplicates" | "trash" | "collection";

export interface View {
  kind: ViewKind;
  collectionId?: string;
}

export const VIEW_TITLES: Record<Exclude<ViewKind, "collection">, string> = {
  all: "All references",
  recent: "Recently added",
  read: "Recently read",
  favorites: "Favourites",
  unsorted: "Unsorted",
  attention: "Needs attention",
  duplicates: "Possible duplicates",
  trash: "Trash",
};

export const RECENT_DAYS = 14;

/** A reference needs attention when it is not Verified, or a retraction notice,
 * expression of concern or failed retraction check is on record. */
export function needsAttention(r: Reference): boolean {
  const rs = r.retraction?.status;
  return r.label !== "verified" || rs === "retracted" || rs === "concern" || rs === "unknown";
}

export function viewTitle(view: View, collections: Collection[]): string {
  if (view.kind === "collection") return collections.find((c) => c.id === view.collectionId)?.name ?? "Collection";
  return VIEW_TITLES[view.kind];
}

export function refsForView(all: Reference[], view: View, now = Date.now(), dupIds: Set<string> = new Set()): Reference[] {
  const active = all.filter((r) => !r.deleted_at);
  switch (view.kind) {
    case "all":
      return active;
    case "recent": {
      const since = now - RECENT_DAYS * 86_400_000;
      return active.filter((r) => Date.parse(r.approved_at) >= since);
    }
    case "read":
      return active.filter((r) => r.read_at);
    case "favorites":
      return active.filter((r) => r.favorite);
    case "unsorted":
      return active.filter((r) => r.collection_ids.length === 0);
    case "attention":
      return active.filter(needsAttention);
    case "duplicates":
      return active.filter((r) => dupIds.has(r.id));
    case "trash":
      return all.filter((r) => r.deleted_at);
    case "collection":
      return active.filter((r) => view.collectionId && r.collection_ids.includes(view.collectionId));
  }
}

export function viewCounts(all: Reference[], collections: Collection[], dupIds: Set<string>, now = Date.now()) {
  const kinds: Exclude<ViewKind, "collection">[] = ["all", "recent", "read", "favorites", "unsorted", "attention", "duplicates", "trash"];
  const counts: Record<string, number> = {};
  for (const k of kinds) counts[k] = refsForView(all, { kind: k }, now, dupIds).length;
  for (const c of collections) counts[`c:${c.id}`] = refsForView(all, { kind: "collection", collectionId: c.id }, now).length;
  return counts;
}

// ------------------------------------------------------------------ search and filters
export interface Filters {
  labels: Label[];        // empty = any
  retractedOnly: boolean; // retracted or expression of concern
  yearFrom: number | null;
  yearTo: number | null;
  unreadOnly: boolean;
}

export const NO_FILTERS: Filters = { labels: [], retractedOnly: false, yearFrom: null, yearTo: null, unreadOnly: false };

export function activeFilterCount(f: Filters): number {
  return (f.labels.length ? 1 : 0) + (f.retractedOnly ? 1 : 0) + (f.yearFrom || f.yearTo ? 1 : 0) + (f.unreadOnly ? 1 : 0);
}

function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function matchesSearch(r: Reference, q: string): boolean {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = fold([r.title, r.authors.join(" "), r.container, r.doi ?? "", r.year ?? "", r.notes].join(" "));
  return terms.every((t) => hay.includes(t));
}

export function applyFilters(refs: Reference[], q: string, f: Filters): Reference[] {
  return refs.filter((r) => {
    if (!matchesSearch(r, q)) return false;
    if (f.labels.length && !f.labels.includes(r.label)) return false;
    if (f.retractedOnly && !["retracted", "concern"].includes(r.retraction?.status ?? "")) return false;
    if (f.yearFrom && (!r.year || r.year < f.yearFrom)) return false;
    if (f.yearTo && (!r.year || r.year > f.yearTo)) return false;
    if (f.unreadOnly && r.read_at) return false;
    return true;
  });
}

// ------------------------------------------------------------------ sorting
export type SortKey = "authors" | "year" | "title" | "source" | "trust" | "added";
export interface Sort {
  key: SortKey;
  dir: "asc" | "desc";
}

const TRUST_RANK: Record<Label, number> = { verified: 0, not_yet_verified: 1, ai_suggestion: 2, not_found: 3 };

export function familyName(author: string): string {
  const a = author.trim();
  if (!a) return "";
  return a.includes(",") ? a.split(",")[0].trim() : a.split(/\s+/).slice(-1)[0];
}

/** "LeCun, Y.; Bengio, Y.; Hinton, G." style, as reference managers show it. */
export function authorShort(authors: string[]): string {
  if (!authors.length) return "—";
  const fmt = (a: string) => {
    if (a.includes(",")) return a.trim();
    const parts = a.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    const fam = parts.pop()!;
    return `${fam}, ${parts.map((p) => p[0].toUpperCase() + ".").join(" ")}`;
  };
  return authors.slice(0, 3).map(fmt).join("; ") + (authors.length > 3 ? "; …" : "");
}

export function sortRefs(refs: Reference[], sort: Sort): Reference[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const key = (r: Reference): string | number => {
    switch (sort.key) {
      case "authors": return fold(familyName(r.authors[0] ?? "~"));
      case "year": return r.year ?? (sort.dir === "asc" ? 9999 : -1);
      case "title": return fold(r.title);
      case "source": return fold(r.container || "~");
      case "trust": return TRUST_RANK[r.label];
      case "added": return r.approved_at;
    }
  };
  return [...refs].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return a.title.localeCompare(b.title);
  });
}

// ------------------------------------------------------------------ collections tree
export interface CollectionNode extends Collection {
  children: CollectionNode[];
  depth: number;
}

export function collectionTree(cols: Collection[]): CollectionNode[] {
  const byParent = new Map<string | null, Collection[]>();
  for (const c of cols) {
    const k = c.parent_id && cols.some((p) => p.id === c.parent_id) ? c.parent_id : null;
    byParent.set(k, [...(byParent.get(k) ?? []), c]);
  }
  const build = (parent: string | null, depth: number): CollectionNode[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((c) => ({ ...c, depth, children: depth < 6 ? build(c.id, depth + 1) : [] }));
  return build(null, 0);
}

export function flattenTree(nodes: CollectionNode[]): CollectionNode[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)]);
}
