import type { Label } from "./types";

/** The four trust labels. The same wording is used on the server (backend/labels.py). */
export const LABELS: Record<Label, { text: string; meaning: string; short: string; className: string }> = {
  verified: {
    text: "Verified",
    meaning: "Matched live against a scholarly database (Crossref, doi.org or OpenAlex), or backed by a located passage.",
    short: "Matched a live scholarly record.",
    className: "lbl-verified",
  },
  not_yet_verified: {
    text: "Not yet verified",
    meaning: "Not checked yet, or the live check could not run. Never treated as verified.",
    short: "Not checked yet, or the check could not run.",
    className: "lbl-pending",
  },
  ai_suggestion: {
    text: "AI suggestion",
    meaning: "Written by AI, with no source checked behind it.",
    short: "Written by AI; no source checked.",
    className: "lbl-ai",
  },
  not_found: {
    text: "Not found",
    meaning: "No matching record in the databases that were checked. It may not exist.",
    short: "No match in the databases checked.",
    className: "lbl-notfound",
  },
};

export const LABEL_ORDER: Label[] = ["verified", "not_yet_verified", "ai_suggestion", "not_found"];
