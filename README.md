# Paper Trail

AI Club Hackathon 2026 — team: Nihal Pusthe · Yash Petkar · Siddal · Hemanth

A research workspace that helps students find, check, organise and cite sources honestly.
Every reference carries a trust label, a made-up reference is never shown as real, and
nothing enters the reference list without the student's one-click approval.

## Stage 1a — what works now

| Must-pass check | How it works |
|---|---|
| **Fake reference test** | Any reference (fields or a pasted citation) is checked live: the DOI against Crossref and the doi.org registry, and title / authors / year against Crossref and OpenAlex. A made-up title, author or DOI is labelled **Not found**. If the databases cannot be reached it is labelled **Not yet verified** — never **Verified**. |
| **Trust labels on everything** | Four labels — Verified, Not yet verified, AI suggestion, Not found — on every search result, check result and saved reference, with an on-screen key on every page. |
| **One-click approval** | Searching and checking save nothing. A source is added only when the student clicks *Approve & add*. The server re-checks it live first; a Not found reference can never be added. |
| **APA 7 export** | Copy (rich text, keeps italics) or download as Word (.docx, APA layout) or text. Formatted by citeproc-js with the official CSL APA 7 style from registered metadata. |
| **AI-use statement** | Generated only from the project's append-only activity log, ready to paste. |
| **Works on a phone** | Phone-first layout with a bottom tab bar; tested at 390 × 844. |

Also in stage 1a: retraction check (Crossref, including Retraction Watch data) on every approved paper,
re-check for references that could not be verified, and an activity log.

## Library (reference-manager layout)

A familiar reference-manager layout — icon rail, library sidebar, sortable reference table and a
detail panel — with the trust labels built in.

| Feature | Details |
|---|---|
| **Library views** | All references, Recently added (14 days), Recently read, Favourites, Unsorted, **Needs attention** (not verified, retracted, expression of concern or retraction check failed), Duplicates, Trash |
| **Collections** | Nested collections; create, rename, delete (references are kept); drag rows onto a collection; approve a source straight into the open collection |
| **Table** | Sort by authors, year, title, source, trust or date added; search title / authors / source / DOI / notes (accent- and case-insensitive); filter by trust label, retraction, year range, unread |
| **Bulk actions** | Select many → add to / remove from collection, favourite, mark read, export, move to Trash; restore or delete for good from Trash (with confirmation) |
| **Detail panel** | Trust label and why, field-by-field check results, retraction status, *Check again*, one-click APA 7 citation, collections, notes (autosave), read / unread |
| **Duplicates** | Found by code, not AI: near-identical titles (≥ 0.93 similarity), years within one, a shared author family name. Merge keeps the chosen record (Verified first) and moves the others to Trash, carrying collections, favourite and notes over |
| **Export** | APA 7 (copy, Word, text), **BibTeX** and **RIS** — Verified references only, the rest reported, never guessed |
| **Import** | BibTeX / RIS from Mendeley, Zotero, EndNote or Google Scholar. Every item is checked live; a made-up entry is Not found and cannot be added; nothing is added until approved |
| **Phone** | Slide-out library menu, reference cards, full-screen details, bottom navigation |

Library actions (favourite, collections, notes, Trash) can never change a trust label: that only
changes through a live re-check. The schema migrates in place (new columns are added; nothing is
dropped), serialised with a Postgres advisory lock so concurrent cold starts are safe.

**Verified** means: a live record matches every field the student entered. For a pasted citation, the
record's title, first author and year must all appear in it. **Not found** means no match in the
databases that were checked — it does not prove a work does not exist anywhere.

## Accounts and sign-in

Guests can use every feature; signing in keeps a library private and on every device.

* **Login page** — sign in, create an account, or continue as a guest. After signing in, a guest library can be
  saved to the account with one click.
* **Neon Auth (managed Better Auth)** through a **same-origin proxy** at `/api/auth/*`: the session cookie is
  re-issued for our own domain (first-party), so browsers that block third-party cookies (Safari on iPhone) keep
  people signed in. The same approach as Neon's own Next.js SDK.
* **API identity** — the browser sends Neon Auth's short-lived JWT; the server verifies the EdDSA signature against
  Neon's JWKS, plus issuer, audience and expiry (algorithm confusion and `none` are rejected).
* **Ownership** — a project saved to an account is visible only to that account; anyone else gets "not found".
  The account id is never sent to the browser. Guest projects work exactly as before.
* Needs `NEON_AUTH_BASE_URL` (set by the Neon integration) and the site's domain in Neon → Auth → Configuration →
  Domains. `/api/health/keys` reports whether the sign-in service is reachable.

## Architecture

* `src/` — React + TypeScript front end (Vite)
* `api/index.py` → `backend/` — FastAPI on Vercel's Python runtime
  * `providers.py` — Crossref, doi.org and OpenAlex adapters with explicit ok / not_found / unavailable states
  * `records.py` — normalisation and field comparison (deterministic, no AI)
  * `verify.py` — fail-closed labelling rules and retraction check
  * `db.py` — PostgreSQL (Neon) via SQLAlchemy; append-only audit log
* `src/csl/apa.csl` — APA 7th edition CSL style (Citation Style Language project, CC BY-SA 3.0)

## Run locally

```bash
pip install -r requirements.txt
npm install
DATABASE_URL=sqlite:///./local.db uvicorn backend.app:app --port 8000   # terminal 1
npm run dev                                                             # terminal 2 → http://localhost:5173
```

## Tests

```bash
python -m pytest tests -q                      # 114 offline tests (recorded provider responses)
RUN_LIVE=1 python -m pytest tests/test_live.py # 10 tests against the real Crossref / doi.org / OpenAlex
npm test                                       # 22 tests: APA 7, AI-use statement, library views, BibTeX / RIS
node tests/e2e/journey.cjs                     # browser journey, desktop + phone (needs Playwright; BASE=<site url>)
python tests/e2e/live_api_check.py <site url>  # 32 live checks of the deployed API
# sign-in journey against a local stand-in for Neon Auth (test accounts only):
#   uvicorn tests.e2e.mock_neon_auth:app --port 8100
#   NEON_AUTH_BASE_URL=http://127.0.0.1:8100/neondb/auth uvicorn backend.app:app --port 8000
#   npm run build && npx vite preview --port 4173 ; node tests/e2e/auth_journey.cjs
```

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Set automatically when the Neon database is connected |
| `CROSSREF_MAILTO` | recommended | Contact email for Crossref's polite pool |
| `OPENALEX_API_KEY` | recommended | Free key from openalex.org/settings/api |
| `LLM_PROVIDER` | stage 1b | `groq` or `gemini` (small letters) |
| `LLM_API_KEY` | stage 1b | Free key from console.groq.com/keys (Groq) or aistudio.google.com (Gemini) |
| `GEMINI_API_KEY` | optional | Backup Gemini key used if the main provider fails |

No secret is ever sent to the browser.

To confirm the saved keys work, open `/api/health/keys`. Each key is tested with its provider and reported as `valid`, `invalid`, `not_configured`, `rate_limited` or `unavailable` — the key itself is never shown.
