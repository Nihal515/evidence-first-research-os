// Content for the Paper Trail landing page, copied from Team 1's Paper Trail
// (Yashpetkar7/Ai-Club-Hackathon: src/fixtures/sample.ts and src/policy/policy.ts).
// `built` marks what exists in this workspace today, so the page never claims more.

export const EXAMPLES = [
  { key: "real", label: "A real paper", text: "10.1126/science.adh2586" },
  { key: "fake", label: "An invented DOI", text: "10.1073/pnas.1523821113" },
  { key: "retracted", label: "A retracted paper", text: "10.1108/jrit-01-2024-0017" },
  {
    key: "hijacked",
    label: "A hijacked DOI",
    text: "Hargrove, L. (2024). Generative AI and the student performance paradox. American Economic Review, 114(2). https://doi.org/10.1257/aer.20160696",
  },
] as const;

export type AgentKind = "ai" | "code";

export const AGENTS: { id: string; name: string; kind: AgentKind; minLevel: number; built: boolean }[] = [
  { id: "planner", name: "Planner", kind: "ai", minLevel: 1, built: true }, // AI search terms
  { id: "scout", name: "Scout", kind: "code", minLevel: 0, built: true }, // search: Crossref and OpenAlex
  { id: "checker", name: "Checker", kind: "code", minLevel: 0, built: true }, // field-by-field check
  { id: "analyst", name: "Analyst", kind: "code", minLevel: 0, built: false },
  { id: "reader", name: "Reader", kind: "ai", minLevel: 2, built: true }, // AI quotes from the abstract
  { id: "quote-guard", name: "Quote guard", kind: "code", minLevel: 0, built: true }, // exact-quote check
  { id: "challenger", name: "Challenger", kind: "ai", minLevel: 3, built: true }, // claim vs abstract
  { id: "reviewer", name: "Reviewer", kind: "code", minLevel: 0, built: false },
  { id: "clerk", name: "Clerk", kind: "code", minLevel: 0, built: true }, // APA 7 list and AI-use statement
];

export const AI_LEVELS = [
  { level: 0, name: "No AI" },
  { level: 1, name: "Find and check" },
  { level: 2, name: "Read and summarise" },
  { level: 3, name: "Challenge my draft" },
];

/** A bare DOI (with or without the doi.org prefix). */
export const BARE_DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i;

/** Lines that look like separate references in a pasted block. */
export function referenceLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 12);
}

export const HANDOFF = "pt.handoff"; // sessionStorage key: a pasted list handed to the workspace import
