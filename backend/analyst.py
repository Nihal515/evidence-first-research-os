"""The Analyst: plain code, no AI.

For each candidate source it reads the abstract from OpenAlex and:
* scores relevance to the research question with TF-IDF cosine similarity over the
  candidate set (title counted twice, abstract once);
* sorts the abstract's own sentences into aim, method, findings and limits by cue words;
* names the study design from method cues (meta-analysis, experiment, survey, ...);
* matches each of the student's claims to the sources that best address it.
Every sentence it shows is the paper's own; it writes nothing of its own.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from typing import Optional
from urllib.parse import quote

import httpx

from . import providers
from .openaccess import abstract_from_inverted_index

STOP = set("""a an the of and or in on for to with at by from as is are was were be been being this that these those
it its into than then there their they them we our us you your i he she his her not no but if so such can could may
might will would should do does did done has have had also more most less least very over under between among about
across after before during within without per via how what which who whom whose why when where while whether both each
other some any all many much few new using use used based study studies paper research effect effects impact role""".split())

CUES = {
    "aim": r"\b(we (examine|investigate|study|explore|ask|analy[sz]e|assess|evaluate|test|propose|develop)|this (study|paper|article|research)|the (aim|purpose|objective|goal)|aims? to|seeks? to|in order to understand)\b",
    "method": r"\b(data|dataset|sample|participants|respondents|randomi[sz]ed|random(ly)? (assign|allocat)|assigned|recruited|experiment|trial|survey|interview|questionnaire|panel|regression|meta-analys|systematic review|case stud|cohort|longitudinal|cross-sectional|we (use|conduct|collect|draw on|employ|estimate)|n ?= ?\d)",
    "findings": r"\b(we (find|show|document|observe|report)|results? (show|suggest|indicate|reveal)|findings|found that|led to|leads to|increase[sd]?|decrease[sd]?|improve[sd]?|reduce[sd]?|significant(ly)?|associated with|evidence that|outperform)",
    "limits": r"\b(limitation|limited|caution|cannot|may not|does not generali[sz]e|future (research|work)|further research|however,|although|caveat|bias)",
}

DESIGNS = [  # strongest first: the first match names the design
    ("Meta-analysis / systematic review", r"\b(meta-analys|systematic review|scoping review)"),
    ("Randomised experiment", r"\b(randomi[sz]ed|field experiment|controlled trial|rct\b|randomly assigned|experiment)"),
    ("Quasi-experiment", r"\b(quasi-experiment|natural experiment|difference-in-differences|regression discontinuity|instrumental variable)"),
    ("Longitudinal / panel", r"\b(longitudinal|panel data|cohort)"),
    ("Survey / cross-sectional", r"\b(survey|questionnaire|cross-sectional|respondents)"),
    ("Qualitative", r"\b(interview|focus group|ethnograph|case stud|qualitative)"),
    ("Review / theory", r"\b(review|framework|conceptual|theor(y|etical)|perspective)"),
]


def tokens(text: str) -> list[str]:
    words = re.findall(r"[a-z][a-z0-9\-]{1,}", (text or "").lower())
    out = []
    for w in words:
        if w in STOP or len(w) < 3:
            continue
        for suf in ("ings", "ing", "ies", "ers", "es", "ed", "s"):  # a light stemmer, enough for matching
            if w.endswith(suf) and len(w) - len(suf) >= 4:
                w = w[: -len(suf)] + ("y" if suf == "ies" else "")
                break
        out.append(w)
    return out


def tfidf_vectors(docs: list[list[str]]) -> list[dict[str, float]]:
    n = len(docs)
    df = Counter(t for d in docs for t in set(d))
    vecs = []
    for d in docs:
        tf = Counter(d)
        v = {t: (1 + math.log(c)) * math.log((n + 1) / (df[t] + 0.5)) for t, c in tf.items()}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs.append({t: x / norm for t, x in v.items()})
    return vecs


def cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(x * b.get(t, 0.0) for t, x in a.items())


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z(])", re.sub(r"\s+", " ", text or "").strip())
    return [p.strip() for p in parts if len(p.strip()) > 25]


def sort_sentences(abstract: str) -> dict[str, list[str]]:
    """Each sentence goes to the heading whose cues it matches most (limits wins ties);
    the opening sentence is the aim when nothing else claims it."""
    out: dict[str, list[str]] = {k: [] for k in CUES}
    sents = sentences(abstract)
    for i, s in enumerate(sents):
        low = s.lower()
        scores = {k: len(re.findall(rx, low)) for k, rx in CUES.items()}
        best = max(scores, key=lambda k: (scores[k], k == "limits", k == "findings"))
        if scores[best] == 0:
            best = "aim" if i == 0 else ("findings" if i == len(sents) - 1 else "")
        if best and len(out[best]) < 2:
            out[best].append(s)
    return out


def design_of(text: str) -> Optional[str]:
    low = (text or "").lower()
    for name, rx in DESIGNS:
        if re.search(rx, low):
            return name
    return None


def fetch_works(client: httpx.Client, dois: list[str]) -> dict[str, dict]:
    """OpenAlex records for up to 50 DOIs in one request."""
    if not dois:
        return {}
    flt = "doi:" + "|".join(f"https://doi.org/{quote(d.lower(), safe='/')}" for d in dois[:50])
    params = providers._openalex_params({"filter": flt, "per_page": 50,
                                         "select": "doi,title,publication_year,cited_by_count,type,abstract_inverted_index,"
                                                   "open_access,primary_location"})
    r, _reason = providers._get(client, "https://api.openalex.org/works", params=params, headers=providers._headers())
    if r is None or r.status_code != 200:
        return {}
    out = {}
    for w in (providers._json(r) or {}).get("results") or []:
        doi = (w.get("doi") or "").lower().removeprefix("https://doi.org/")
        if doi:
            out[doi] = w
    return out


def analyse(client: httpx.Client, question: str, keywords: str, items: list[dict], claims: list[str]) -> dict:
    """items: [{doi, title, year?}] from the Scout and Checker. Returns them ranked by relevance."""
    works = fetch_works(client, [i["doi"] for i in items])
    docs, rows = [], []
    for it in items:
        doi = it["doi"].lower()
        w = works.get(doi) or {}
        abstract = abstract_from_inverted_index(w.get("abstract_inverted_index")) or ""
        title = it.get("title") or w.get("title") or ""
        docs.append(tokens(title) * 2 + tokens(abstract))
        venue = ((w.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
        rows.append({"doi": doi, "title": title, "year": it.get("year") or w.get("publication_year"),
                     "cited_by": w.get("cited_by_count"), "type": w.get("type") or "", "venue": venue,
                     "open_access": bool((w.get("open_access") or {}).get("is_oa")), "has_abstract": bool(abstract),
                     "design": design_of(f"{title}. {abstract}"), "sections": sort_sentences(abstract),
                     "abstract_words": len(abstract.split())})
    query_tokens = tokens(f"{question} {keywords}")
    claim_tokens = [tokens(c) for c in claims]
    vecs = tfidf_vectors(docs + [query_tokens] + claim_tokens)
    qv = vecs[len(docs)]
    for row, dv in zip(rows, vecs[: len(docs)]):
        row["relevance"] = round(cosine(dv, qv), 4)
    top = max((r["relevance"] for r in rows), default=0) or 1.0
    for row in rows:
        row["relevance_pct"] = round(100 * row["relevance"] / top)
    order = sorted(range(len(rows)), key=lambda i: (rows[i]["relevance"], rows[i]["has_abstract"], rows[i]["cited_by"] or 0),
                   reverse=True)
    claim_matches = []
    for ci, claim in enumerate(claims):
        cv = vecs[len(docs) + 1 + ci]
        scored = sorted(((round(cosine(vecs[i], cv), 4), rows[i]["doi"]) for i in range(len(rows))), reverse=True)
        claim_matches.append({"claim": claim, "best": [{"doi": d, "score": s} for s, d in scored[:3] if s > 0]})
    return {"method": "TF-IDF cosine similarity over the candidates' titles and abstracts (OpenAlex); "
                      "sentences sorted by cue words; plain code, no AI.",
            "abstracts_found": sum(1 for r in rows if r["has_abstract"]),
            "results": [rows[i] for i in order], "claims": claim_matches}
