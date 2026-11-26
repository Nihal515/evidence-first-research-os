import { getToken } from "./auth";
import type {
  AuditEvent,
  BulkAction,
  CheckInput,
  Collection,
  CheckResult,
  LabCorpus,
  LabRun,
  Project,
  Reference,
  Retraction,
  SearchResponse,
  Summary,
} from "./types";

export class ApiError extends Error {
  status: number;
  result?: CheckResult;
  constructor(message: string, status: number, result?: CheckResult) {
    super(message);
    this.status = status;
    this.result = result;
  }
}

const TIMEOUT_MS = 28000; // just under the server's 30 s limit

async function fetchOnce(path: string, init?: RequestInit, forceToken = false): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const token = await getToken(forceToken); // null for guests
  try {
    return await fetch(path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const retryable = method === "GET"; // reads are safe to repeat; writes are never retried automatically
  let res: Response | null = null;
  for (let attempt = 0; attempt < (retryable ? 2 : 1); attempt++) {
    try {
      res = await fetchOnce(path, init);
      if (res.status === 401 && attempt === 0) {
        // the sign-in token expired: refresh it once from the session and repeat the request
        res = await fetchOnce(path, init, true);
      }
      if (retryable && attempt === 0 && [502, 503, 504].includes(res.status)) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      break;
    } catch {
      res = null;
      if (retryable && attempt === 0) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
    }
  }
  if (!res) throw new ApiError("Could not reach the server. Check your connection and try again.", 0);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body?.detail;
    if (detail && typeof detail === "object" && "message" in detail) {
      throw new ApiError(String(detail.message), res.status, detail.result as CheckResult);
    }
    if (Array.isArray(detail)) {
      throw new ApiError("Please check the details you entered.", res.status);
    }
    if (res.status === 504) throw new ApiError("The server took too long to answer. Please try again.", 504);
    throw new ApiError(typeof detail === "string" ? detail : `Request failed (${res.status}).`, res.status);
  }
  return body as T;
}

const json = (data: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(data) });

export interface Me {
  signed_in: boolean;
  user: { id: string; email: string; name: string; email_verified: boolean } | null;
  auth_configured: boolean;
}

export const api = {
  me: () => request<Me>("/api/me"),
  myProjects: () => request<Project[]>("/api/me/projects"),
  claim: (id: string) => request<Project>(`/api/projects/${id}/claim`, { method: "POST" }),
  health: () => request<{ database: string; llm: string }>("/api/health"),
  createProject: (title: string, question: string) => request<Project>("/api/projects", json({ title, question })),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  updateProject: (id: string, title: string, question: string) =>
    request<Project>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify({ title, question }) }),
  search: (id: string, q: string) => request<SearchResponse>(`/api/projects/${id}/search?q=${encodeURIComponent(q)}`),
  check: (id: string, input: CheckInput) => request<CheckResult>(`/api/projects/${id}/check`, json(input)),
  /** Check without a project: nothing is saved. */
  publicCheck: (input: CheckInput) => request<CheckResult & { retraction?: Retraction | null }>("/api/check", json(input)),
  lab: () => request<LabCorpus>("/api/lab"),
  labRun: (caseId: string) => request<LabRun>(`/api/lab/run?case_id=${encodeURIComponent(caseId)}`, { method: "POST" }),
  approve: (id: string, input: CheckInput, collectionId?: string | null) =>
    request<Reference>(`/api/projects/${id}/references`, json(collectionId ? { ...input, collection_id: collectionId } : input)),
  references: (id: string, includeTrash = false) =>
    request<Reference[]>(`/api/projects/${id}/references${includeTrash ? "?include_trash=true" : ""}`),
  remove: (id: string, rid: string, permanent = false) =>
    request<{ removed: string }>(`/api/projects/${id}/references/${rid}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" }),
  patch: (id: string, rid: string, body: { favorite?: boolean; read?: boolean; notes?: string; trashed?: boolean }) =>
    request<Reference>(`/api/projects/${id}/references/${rid}`, { method: "PATCH", body: JSON.stringify(body) }),
  bulk: (id: string, ids: string[], action: BulkAction, collectionId?: string) =>
    request<{ count: number }>(`/api/projects/${id}/references/bulk`,
      json({ ids, action, ...(collectionId ? { collection_id: collectionId } : {}) })),
  collections: (id: string) => request<Collection[]>(`/api/projects/${id}/collections`),
  createCollection: (id: string, name: string, parentId?: string | null) =>
    request<Collection>(`/api/projects/${id}/collections`, json({ name, ...(parentId ? { parent_id: parentId } : {}) })),
  renameCollection: (id: string, cid: string, name: string) =>
    request<Collection>(`/api/projects/${id}/collections/${cid}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteCollection: (id: string, cid: string) =>
    request<{ deleted: string[] }>(`/api/projects/${id}/collections/${cid}`, { method: "DELETE" }),
  library: (id: string) =>
    request<{ references: Reference[]; collections: Collection[]; duplicates: { groups: string[][]; rule: string } }>(
      `/api/projects/${id}/library`),
  duplicates: (id: string) => request<{ groups: string[][]; rule: string }>(`/api/projects/${id}/duplicates`),
  merge: (id: string, keepId: string, removeIds: string[]) =>
    request<Reference>(`/api/projects/${id}/duplicates/merge`, json({ keep_id: keepId, remove_ids: removeIds })),
  freeCopy: (id: string, rid: string) => request<Reference>(`/api/projects/${id}/references/${rid}/free-copy`, { method: "POST" }),
  recheck: (id: string, rid: string) => request<Reference>(`/api/projects/${id}/references/${rid}/recheck`, { method: "POST" }),
  audit: (id: string) => request<AuditEvent[]>(`/api/projects/${id}/audit`),
  summary: (id: string) => request<Summary>(`/api/projects/${id}/summary`),
  event: (id: string, event: string, detail: Record<string, unknown> = {}) =>
    request<{ logged: string }>(`/api/projects/${id}/events`, json({ event, detail })).catch(() => undefined),
};
