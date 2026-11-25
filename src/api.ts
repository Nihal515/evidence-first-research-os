import type {
  AuditEvent,
  CheckInput,
  CheckResult,
  Project,
  Reference,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.", 0);
  }
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
    throw new ApiError(typeof detail === "string" ? detail : `Request failed (${res.status}).`, res.status);
  }
  return body as T;
}

const json = (data: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(data) });

export const api = {
  health: () => request<{ database: string; llm: string }>("/api/health"),
  createProject: (title: string, question: string) => request<Project>("/api/projects", json({ title, question })),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  updateProject: (id: string, title: string, question: string) =>
    request<Project>(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify({ title, question }) }),
  search: (id: string, q: string) => request<SearchResponse>(`/api/projects/${id}/search?q=${encodeURIComponent(q)}`),
  check: (id: string, input: CheckInput) => request<CheckResult>(`/api/projects/${id}/check`, json(input)),
  approve: (id: string, input: CheckInput) => request<Reference>(`/api/projects/${id}/references`, json(input)),
  references: (id: string) => request<Reference[]>(`/api/projects/${id}/references`),
  remove: (id: string, rid: string) => request<{ removed: string }>(`/api/projects/${id}/references/${rid}`, { method: "DELETE" }),
  recheck: (id: string, rid: string) => request<Reference>(`/api/projects/${id}/references/${rid}/recheck`, { method: "POST" }),
  audit: (id: string) => request<AuditEvent[]>(`/api/projects/${id}/audit`),
  summary: (id: string) => request<Summary>(`/api/projects/${id}/summary`),
  event: (id: string, event: string, detail: Record<string, unknown> = {}) =>
    request<{ logged: string }>(`/api/projects/${id}/events`, json({ event, detail })).catch(() => undefined),
};
