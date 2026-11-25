"""Normalised source records, text normalisation and field comparison.

Everything here is deterministic code: no AI is involved in deciding whether a
reference is real.
"""
from __future__ import annotations

import html
import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Iterable, Optional

TITLE_MATCH = 0.90          # similarity needed for a title to count as the same title
TITLE_ONLY_MATCH = 0.97     # stricter bar when only a title (no author/year/DOI) was given

PARTICLES = {
    "van", "von", "de", "der", "den", "del", "della", "da", "di", "du", "la", "le", "el",
    "al", "bin", "ibn", "et", "and", "jr", "sr", "ii", "iii", "iv", "st", "dos", "das", "y",
}

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>]+", re.IGNORECASE)
YEAR_RE = re.compile(r"\b(1[5-9]\d\d|20\d\d)\b")


# ------------------------------------------------------------------ text
def norm(text: Optional[str]) -> str:
    """Lower-case, strip markup, accents and punctuation, collapse spaces."""
    s = re.sub(r"<[^>]+>", " ", text or "")
    s = html.unescape(s)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def clean_markup(text: Optional[str]) -> str:
    """Keep only markup citeproc understands (<i>, <b>, <sup>, <sub>); drop the rest."""
    s = re.sub(r"<(?!/?(i|b|sup|sub)>)[^>]+>", "", text or "")
    return " ".join(s.split())


def plain(text: Optional[str]) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", text or "")).split())


def normalize_doi(value: Optional[str]) -> Optional[str]:
    """Return a bare lower-case DOI, or None if the value is not DOI-shaped."""
    if not value:
        return None
    s = value.strip()
    s = re.sub(r"^(https?://)?(dx\.)?doi\.org/", "", s, flags=re.IGNORECASE)
    s = re.sub(r"^doi:\s*", "", s, flags=re.IGNORECASE)
    s = s.strip().rstrip(".,;")
    if not re.fullmatch(r"10\.\d{4,9}/\S+", s):
        return None
    return s.lower()


def extract_doi(text: str) -> Optional[str]:
    m = DOI_RE.search(text or "")
    if not m:
        return None
    return normalize_doi(m.group(0).rstrip(".,;)]"))


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def years_in(text: str) -> set[int]:
    return {int(y) for y in YEAR_RE.findall(text or "")}


def user_name_tokens(authors: str) -> list[str]:
    """Surname / given-name tokens from free-typed author text, ignoring initials."""
    s = re.sub(r"\bet\.?\s+al\.?", " ", authors or "", flags=re.IGNORECASE)
    s = re.sub(r"\b(?:[A-Z]\.\s*-?\s*)+", " ", s)  # initials such as "Y." "J.-P." "Y.B."
    tokens: list[str] = []
    for raw in re.split(r"[\s,;&/()]+", s):
        letters = re.sub(r"[^A-Za-zÀ-ɏ'\-]", "", raw)
        if not letters:
            continue
        if letters.isupper() and len(letters) <= 3:  # Vancouver-style initials "GE"
            continue
        for t in norm(letters).split():
            if len(t) >= 2 and t not in PARTICLES:
                tokens.append(t)
    return tokens


# ------------------------------------------------------------------ records
@dataclass
class Record:
    provider: str
    doi: Optional[str]
    title: str
    title_variants: list[str]
    authors: list[str]
    family_names: list[str]
    name_tokens: set[str]
    years: set[int]
    container: str = ""
    csl: Optional[dict] = None
    type: str = ""

    @property
    def year(self) -> Optional[int]:
        return min(self.years) if self.years else None

    def summary(self) -> dict:
        return {
            "provider": self.provider,
            "doi": self.doi,
            "title": self.title,
            "authors": self.authors,
            "year": self.year,
            "container": self.container,
            "type": self.type,
        }


def _first(value) -> str:
    if isinstance(value, list):
        return value[0] if value else ""
    return value or ""


def _date_years(*parts) -> set[int]:
    years = set()
    for p in parts:
        try:
            y = (p or {}).get("date-parts", [[None]])[0][0]
            if y:
                years.add(int(y))
        except (TypeError, ValueError, IndexError):
            continue
    return years


def _names(people: Iterable[dict]) -> tuple[list[str], list[str], set[str]]:
    display, families, tokens = [], [], set()
    for p in people or []:
        if p.get("family"):
            given = p.get("given") or ""
            display.append((given + " " + p["family"]).strip())
            families.append(norm(p["family"]))
            source = given + " " + p["family"]
        elif p.get("name") or p.get("literal"):
            name = p.get("name") or p.get("literal")
            display.append(name)
            families.append(norm(name))
            source = name
        else:
            continue
        for t in norm(source).split():
            if len(t) >= 2 and t not in PARTICLES:
                tokens.add(t)
    return display, families, tokens


def _title_variants(title: str, subtitle: str) -> list[str]:
    variants = [norm(title)]
    if subtitle and norm(subtitle) not in norm(title):
        variants.append(norm(f"{title} {subtitle}"))
    return [v for v in variants if v]


CROSSREF_TO_CSL = {
    "journal-article": "article-journal",
    "proceedings-article": "paper-conference",
    "book": "book",
    "edited-book": "book",
    "monograph": "book",
    "reference-book": "book",
    "book-chapter": "chapter",
    "book-section": "chapter",
    "book-part": "chapter",
    "reference-entry": "entry-encyclopedia",
    "posted-content": "article",
    "dissertation": "thesis",
    "report": "report",
    "report-component": "report",
    "dataset": "dataset",
    "standard": "standard",
    "peer-review": "review",
}


def _csl_people(people) -> list[dict]:
    out = []
    for p in people or []:
        if p.get("family"):
            item = {"family": plain(p["family"])}
            if p.get("given"):
                item["given"] = plain(p["given"])
            out.append(item)
        elif p.get("name"):
            out.append({"literal": plain(p["name"])})
    return out


def crossref_to_csl(msg: dict) -> dict:
    """Map a Crossref work to CSL-JSON for the APA 7 formatter (citeproc-js)."""
    title = clean_markup(_first(msg.get("title")))
    subtitle = clean_markup(_first(msg.get("subtitle")))
    if subtitle and norm(subtitle) not in norm(title):
        title = f"{title}: {subtitle}"
    issued = msg.get("issued") or msg.get("published-print") or msg.get("published-online") or {}
    parts = [p for p in (issued.get("date-parts") or [[None]])[0] if p]
    doi = (msg.get("DOI") or "").lower()
    csl = {
        "id": doi or norm(title)[:40],
        "type": CROSSREF_TO_CSL.get(msg.get("type", ""), "article"),
        "title": title,
        "author": _csl_people(msg.get("author")),
    }
    editors = _csl_people(msg.get("editor"))
    if editors:
        csl["editor"] = editors
    if parts:
        csl["issued"] = {"date-parts": [parts]}
    container = clean_markup(_first(msg.get("container-title")))
    if container:
        csl["container-title"] = container
    for key in ("volume", "issue", "page", "publisher"):
        if msg.get(key):
            csl[key] = str(msg[key])
    if doi:
        csl["DOI"] = doi
    elif msg.get("URL"):
        csl["URL"] = msg["URL"]
    return csl


def record_from_crossref(msg: dict) -> Record:
    title = plain(_first(msg.get("title")))
    subtitle = plain(_first(msg.get("subtitle")))
    display, families, tokens = _names(msg.get("author"))
    if not display:  # edited books list editors instead of authors
        display, families, tokens = _names(msg.get("editor"))
    full_title = f"{title}: {subtitle}" if subtitle and norm(subtitle) not in norm(title) else title
    return Record(
        provider="Crossref",
        doi=(msg.get("DOI") or "").lower() or None,
        title=full_title,
        title_variants=_title_variants(title, subtitle),
        authors=display,
        family_names=families,
        name_tokens=tokens,
        years=_date_years(msg.get("issued"), msg.get("published-print"), msg.get("published-online"), msg.get("published")),
        container=plain(_first(msg.get("container-title"))),
        csl=crossref_to_csl(msg),
        type=msg.get("type", ""),
    )


def record_from_csl(csl: dict, provider: str = "doi.org") -> Record:
    title = plain(_first(csl.get("title")))
    display, families, tokens = _names(csl.get("author"))
    doi = (csl.get("DOI") or "").lower() or None
    item = dict(csl)
    item["id"] = doi or norm(title)[:40]
    item["title"] = clean_markup(_first(csl.get("title")))
    if isinstance(item.get("container-title"), list):
        item["container-title"] = _first(item["container-title"])
    item["type"] = CROSSREF_TO_CSL.get(item.get("type", ""), item.get("type") or "article")
    if item["type"] in ("article-journal", "paper-conference", "chapter", "book", "thesis", "report",
                        "dataset", "standard", "review", "entry-encyclopedia", "article"):
        pass
    else:
        item["type"] = "article"
    for k in [k for k in item if k not in {
        "id", "type", "title", "author", "editor", "issued", "container-title", "volume",
        "issue", "page", "publisher", "DOI", "URL"}]:
        item.pop(k, None)
    return Record(
        provider=provider,
        doi=doi,
        title=title,
        title_variants=_title_variants(title, ""),
        authors=display,
        family_names=families,
        name_tokens=tokens,
        years=_date_years(csl.get("issued"), csl.get("published-print"), csl.get("published-online")),
        container=plain(_first(csl.get("container-title"))),
        csl=item,
        type=csl.get("type", ""),
    )


def _split_display_name(name: str) -> dict:
    parts = name.split()
    if len(parts) < 2:
        return {"literal": name}
    return {"family": parts[-1], "given": " ".join(parts[:-1])}


def record_from_openalex(work: dict) -> Record:
    title = plain(work.get("display_name") or "")
    names = [((a.get("author") or {}).get("display_name") or "") for a in work.get("authorships") or []]
    names = [n for n in names if n]
    families, tokens = [], set()
    for n in names:
        parts = norm(n).split()
        if parts:
            families.append(parts[-1])
        tokens.update(t for t in parts if len(t) >= 2 and t not in PARTICLES)
    doi = (work.get("doi") or "").lower().replace("https://doi.org/", "") or None
    year = work.get("publication_year")
    source = ((work.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
    biblio = work.get("biblio") or {}
    csl = {
        "id": doi or norm(title)[:40],
        "type": "article-journal" if work.get("type") in ("article", "journal-article") else "article",
        "title": title,
        "author": [_split_display_name(n) for n in names],
    }
    if year:
        csl["issued"] = {"date-parts": [[int(year)]]}
    if source:
        csl["container-title"] = source
    if biblio.get("volume"):
        csl["volume"] = str(biblio["volume"])
    if biblio.get("issue"):
        csl["issue"] = str(biblio["issue"])
    if biblio.get("first_page"):
        csl["page"] = str(biblio["first_page"]) + (f"-{biblio['last_page']}" if biblio.get("last_page") else "")
    if doi:
        csl["DOI"] = doi
    return Record(
        provider="OpenAlex",
        doi=doi,
        title=title,
        title_variants=_title_variants(title, ""),
        authors=names,
        family_names=families,
        name_tokens=tokens,
        years={int(year)} if year else set(),
        container=source,
        csl=csl,
        type=work.get("type") or "",
    )


# ------------------------------------------------------------------ comparison
@dataclass
class FieldCheck:
    field: str
    status: str  # "match" | "mismatch" | "not_provided"
    detail: str = ""

    def to_dict(self) -> dict:
        return {"field": self.field, "status": self.status, "detail": self.detail}


def title_similarity(user_title: str, rec: Record) -> float:
    u = norm(user_title)
    return max((similarity(u, v) for v in rec.title_variants), default=0.0)


def compare_fields(rec: Record, *, title: str = "", authors: str = "", year: Optional[int] = None,
                   doi: Optional[str] = None) -> list[FieldCheck]:
    checks: list[FieldCheck] = []
    if doi:
        checks.append(FieldCheck("DOI", "match", f"{doi} is registered and resolves to this record"))
    if title.strip():
        sim = title_similarity(title, rec)
        if sim >= TITLE_MATCH:
            checks.append(FieldCheck("Title", "match", f"{round(sim * 100)}% match with “{rec.title}”"))
        else:
            checks.append(FieldCheck("Title", "mismatch", f"Registered title is “{rec.title}” ({round(sim * 100)}% similar)"))
    else:
        checks.append(FieldCheck("Title", "not_provided"))
    tokens = user_name_tokens(authors)
    if tokens:
        unknown = [t for t in tokens if t not in rec.name_tokens]
        family_hit = any(part in tokens for fam in rec.family_names for part in fam.split() if part not in PARTICLES)
        if rec.authors and not unknown and family_hit:
            checks.append(FieldCheck("Authors", "match", "Matches " + ", ".join(rec.authors[:4]) + (" et al." if len(rec.authors) > 4 else "")))
        else:
            registered = ", ".join(rec.authors[:4]) + (" et al." if len(rec.authors) > 4 else "") if rec.authors else "no authors listed"
            missing = f" (not on the record: {', '.join(sorted(set(unknown)))})" if unknown else ""
            checks.append(FieldCheck("Authors", "mismatch", f"Registered authors: {registered}{missing}"))
    else:
        checks.append(FieldCheck("Authors", "not_provided"))
    if year:
        if year in rec.years:
            checks.append(FieldCheck("Year", "match", str(year)))
        else:
            got = ", ".join(str(y) for y in sorted(rec.years)) or "no year"
            checks.append(FieldCheck("Year", "mismatch", f"Registered year: {got}"))
    else:
        checks.append(FieldCheck("Year", "not_provided"))
    return checks


def _title_in_text(rec: Record, text_norm: str) -> float:
    """Best similarity between the record title and a same-length window of the text."""
    words = text_norm.split()
    best = 0.0
    for variant in rec.title_variants:
        if variant and f" {variant} " in f" {text_norm} ":
            return 1.0
        n = len(variant.split())
        for size in {max(n - 1, 1), n, n + 1}:
            for i in range(0, max(len(words) - size + 1, 1)):
                best = max(best, similarity(variant, " ".join(words[i:i + size])))
    return best


def compare_raw(rec: Record, text: str) -> list[FieldCheck]:
    """Compare a pasted citation string with a record."""
    text_norm = norm(text)
    tokens = set(text_norm.split())
    checks: list[FieldCheck] = []
    sim = _title_in_text(rec, text_norm)
    if sim >= TITLE_MATCH:
        checks.append(FieldCheck("Title", "match", f"“{rec.title}” appears in the reference"))
    else:
        checks.append(FieldCheck("Title", "mismatch", f"Closest registered title “{rec.title}” is not in the reference"))
    if rec.family_names:
        first = [p for p in rec.family_names[0].split() if p not in PARTICLES]
        if first and all(p in tokens for p in first):
            checks.append(FieldCheck("Authors", "match", f"First author {rec.authors[0]} appears in the reference"))
        else:
            checks.append(FieldCheck("Authors", "mismatch", f"Registered first author {rec.authors[0]} is not in the reference"))
    else:
        checks.append(FieldCheck("Authors", "not_provided", "The record lists no authors"))
    found_years = years_in(text)
    if found_years:
        if found_years & rec.years:
            checks.append(FieldCheck("Year", "match", ", ".join(str(y) for y in sorted(found_years & rec.years))))
        else:
            got = ", ".join(str(y) for y in sorted(rec.years)) or "no year"
            checks.append(FieldCheck("Year", "mismatch", f"Registered year: {got}"))
    else:
        checks.append(FieldCheck("Year", "not_provided"))
    return checks


def all_match(checks: list[FieldCheck]) -> bool:
    return not any(c.status == "mismatch" for c in checks) and any(c.status == "match" for c in checks)
