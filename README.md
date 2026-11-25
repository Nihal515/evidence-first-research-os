# Evidence-First Research OS

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

**Verified** means: a live record matches every field the student entered. For a pasted citation, the
record's title, first author and year must all appear in it. **Not found** means no match in the
databases that were checked — it does not prove a work does not exist anywhere.

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
python -m pytest tests -q                      # 56 offline tests (recorded provider responses)
RUN_LIVE=1 python -m pytest tests/test_live.py # 10 tests against the real Crossref / doi.org / OpenAlex
npm test                                       # APA 7 formatting and AI-use statement
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
