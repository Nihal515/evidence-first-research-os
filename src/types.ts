export type Label = "verified" | "not_yet_verified" | "ai_suggestion" | "not_found";

export interface Project {
  id: string;
  title: string;
  question: string;
  created_at: string;
  updated_at: string;
}

export interface RecordSummary {
  provider: string;
  doi: string | null;
  title: string;
  authors: string[];
  year: number | null;
  container: string;
  type: string;
}

export interface FieldCheck {
  field: string;
  status: "match" | "mismatch" | "not_provided";
  detail: string;
}

export interface CheckResult {
  label: Label;
  reason: string;
  checks: FieldCheck[];
  sources_checked: string[];
  unavailable: string[];
  record: RecordSummary | null;
  checked_at: string;
  in_list?: boolean;
}

export interface SearchResult {
  label: Label;
  reason: string;
  record: RecordSummary;
  in_list: boolean;
}

export interface SearchResponse {
  status: "ok" | "unavailable";
  provider: string | null;
  retrieved_at: string;
  note: string;
  results: SearchResult[];
}

export interface Retraction {
  status?: "retracted" | "concern" | "corrected" | "none_found" | "unknown";
  detail?: string;
}

export interface CslItem {
  id: string;
  type: string;
  title: string;
  [key: string]: unknown;
}

export interface Reference {
  id: string;
  label: Label;
  reason: string;
  doi: string | null;
  title: string;
  authors: string[];
  year: number | null;
  container: string;
  provider: string;
  csl: CslItem | null;
  checks: FieldCheck[];
  retraction: Retraction;
  user_input: Record<string, unknown>;
  checked_at: string;
  approved_at: string;
  // library state
  favorite: boolean;
  read_at: string | null;
  deleted_at: string | null;
  notes: string;
  abstract: string | null;
  oa_pdf_url: string | null;
  free_copy: FreeCopy | null;
  has_uploaded_pdf: boolean;
  collection_ids: string[];
}

export interface FreeCopy {
  status: "found" | "none" | "unavailable" | "no_doi";
  url?: string;
  is_pdf?: boolean;
  version?: string | null;
  version_text?: string;
  host?: string;
  host_type?: string;
  license?: string;
  oa_status?: string;
  detail?: string;
  checked_at: string;
}

export interface Collection {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
}

export type BulkAction =
  | "favorite" | "unfavorite" | "mark_read" | "mark_unread" | "trash" | "restore" | "delete_forever"
  | "add_to_collection" | "remove_from_collection";

export interface AuditEvent {
  ts: string;
  actor: "user" | "system" | "ai";
  event: string;
  detail: Record<string, unknown>;
}

export interface Summary {
  project: { title: string; question: string };
  searches: number;
  search_providers: string[];
  checks: { total: number; verified: number; not_found: number; not_yet_verified: number };
  sources_checked: string[];
  references: { total: number; verified: number; not_yet_verified: number; not_found: number };
  approvals: number;
  exports: number;
  ai_runs: number;
  first_activity: string | null;
  last_activity: string | null;
  generated_at: string;
}

export type CheckInput =
  | { mode: "fields"; title: string; authors: string; year: number | null; doi: string }
  | { mode: "text"; text: string }
  | { mode: "doi"; doi: string };
