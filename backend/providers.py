"""HTTP adapters for Crossref, doi.org and OpenAlex.

Every adapter returns a ProviderResult with an explicit status:

* ``ok``          – the provider answered and returned data
* ``not_found``   – the provider answered and said the item does not exist
* ``unavailable`` – no usable answer (timeout, rate limit, server error)

Keeping ``unavailable`` separate from ``not_found`` is what stops a provider
outage from ever being shown as "Not found" or as "Verified".
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import quote

import httpx

OK = "ok"
NOT_FOUND = "not_found"
UNAVAILABLE = "unavailable"

TIMEOUT = httpx.Timeout(8.0, connect=5.0)
BASE_UA = "EvidenceFirstResearchOS/0.1 (AI Club Hackathon 2026 prototype)"

CROSSREF_SELECT = ",".join(
    [
        "DOI",
        "title",
        "subtitle",
        "author",
        "editor",
        "issued",
        "published-print",
        "published-online",
        "container-title",
        "type",
        "volume",
        "issue",
        "page",
        "publisher",
        "URL",
    ]
)


@dataclass
class ProviderResult:
    status: str
    provider: str
    data: Any = None
    detail: str = ""


def _mailto() -> str:
    return os.getenv("CROSSREF_MAILTO", "").strip()


def _headers(accept: Optional[str] = None) -> dict:
    mail = _mailto()
    ua = f"{BASE_UA} mailto:{mail}" if mail else BASE_UA
    h = {"User-Agent": ua}
    if accept:
        h["Accept"] = accept
    return h


def _crossref_params(extra: Optional[dict] = None) -> dict:
    p = dict(extra or {})
    if _mailto():
        p["mailto"] = _mailto()
    return p


def _openalex_params(extra: Optional[dict] = None) -> dict:
    p = dict(extra or {})
    key = os.getenv("OPENALEX_API_KEY", "").strip()
    if key:
        p["api_key"] = key
    return p


def _retry_wait(response: httpx.Response) -> float:
    try:
        return min(max(float(response.headers.get("retry-after", "1")), 0.2), 2.0)
    except ValueError:
        return 1.0


def make_client() -> httpx.Client:
    return httpx.Client(timeout=TIMEOUT, follow_redirects=True)


def _get(client: httpx.Client, url: str, *, params=None, headers=None, retries: int = 1):
    """GET with one bounded retry on rate limits, server errors and network errors.

    Returns ``(response, "")`` for any definite answer (2xx/4xx other than 429),
    or ``(None, reason)`` when no usable answer was obtained.
    """
    reason = ""
    for attempt in range(retries + 1):
        try:
            r = client.get(url, params=params, headers=headers)
        except httpx.HTTPError as exc:  # timeouts, DNS, connection resets
            reason = f"network error ({exc.__class__.__name__})"
            if attempt < retries:
                time.sleep(0.5)
                continue
            return None, reason
        if r.status_code == 429 or r.status_code >= 500:
            reason = "rate limited" if r.status_code == 429 else f"server error {r.status_code}"
            if attempt < retries:
                time.sleep(_retry_wait(r))
                continue
            return None, reason
        return r, ""
    return None, reason


def _json(r: httpx.Response):
    try:
        return r.json()
    except ValueError:
        return None


# ---------------------------------------------------------------- Crossref
def crossref_work(client: httpx.Client, doi: str) -> ProviderResult:
    url = f"https://api.crossref.org/works/{quote(doi, safe='/')}"
    r, reason = _get(client, url, params=_crossref_params(), headers=_headers())
    if r is None:
        return ProviderResult(UNAVAILABLE, "Crossref", detail=reason)
    if r.status_code == 404:
        return ProviderResult(NOT_FOUND, "Crossref")
    body = _json(r)
    if r.status_code != 200 or not isinstance(body, dict) or "message" not in body:
        return ProviderResult(UNAVAILABLE, "Crossref", detail=f"unexpected response {r.status_code}")
    return ProviderResult(OK, "Crossref", body["message"])


def crossref_search(client: httpx.Client, query: str, rows: int = 10) -> ProviderResult:
    params = _crossref_params({"query.bibliographic": query, "rows": rows, "select": CROSSREF_SELECT})
    r, reason = _get(client, "https://api.crossref.org/works", params=params, headers=_headers())
    if r is None:
        return ProviderResult(UNAVAILABLE, "Crossref", detail=reason)
    body = _json(r)
    if r.status_code != 200 or not isinstance(body, dict):
        return ProviderResult(UNAVAILABLE, "Crossref", detail=f"unexpected response {r.status_code}")
    items = (body.get("message") or {}).get("items") or []
    return ProviderResult(OK, "Crossref", items)


def crossref_updates(client: httpx.Client, doi: str) -> ProviderResult:
    """Notices (retractions, corrections, expressions of concern) that update ``doi``.

    Crossref includes the Retraction Watch database in these records.
    """
    params = _crossref_params({"filter": f"updates:{doi}", "rows": 20, "select": "DOI,title,update-to"})
    r, reason = _get(client, "https://api.crossref.org/works", params=params, headers=_headers())
    if r is None:
        return ProviderResult(UNAVAILABLE, "Crossref", detail=reason)
    body = _json(r)
    if r.status_code != 200 or not isinstance(body, dict):
        return ProviderResult(UNAVAILABLE, "Crossref", detail=f"unexpected response {r.status_code}")
    return ProviderResult(OK, "Crossref", (body.get("message") or {}).get("items") or [])


# ---------------------------------------------------------------- doi.org
def doi_registered(client: httpx.Client, doi: str) -> ProviderResult:
    """Ask the DOI registry (Handle system) whether the DOI exists at all."""
    url = f"https://doi.org/api/handles/{quote(doi, safe='/')}"
    r, reason = _get(client, url, headers=_headers())
    if r is None:
        return ProviderResult(UNAVAILABLE, "doi.org", detail=reason)
    body = _json(r) or {}
    code = body.get("responseCode") if isinstance(body, dict) else None
    if r.status_code == 404 or code in (100, 200):
        return ProviderResult(NOT_FOUND, "doi.org")
    if r.status_code == 200 and code == 1:
        return ProviderResult(OK, "doi.org")
    return ProviderResult(UNAVAILABLE, "doi.org", detail=f"unexpected response {r.status_code}")


def doi_csl(client: httpx.Client, doi: str) -> ProviderResult:
    """CSL-JSON metadata through doi.org content negotiation (works for DataCite DOIs too)."""
    url = f"https://doi.org/{quote(doi, safe='/')}"
    r, reason = _get(client, url, headers=_headers("application/vnd.citationstyles.csl+json"))
    if r is None:
        return ProviderResult(UNAVAILABLE, "doi.org", detail=reason)
    if r.status_code == 404:
        return ProviderResult(NOT_FOUND, "doi.org")
    body = _json(r)
    if r.status_code != 200 or not isinstance(body, dict) or not body.get("title"):
        return ProviderResult(UNAVAILABLE, "doi.org", detail=f"no readable metadata ({r.status_code})")
    return ProviderResult(OK, "doi.org", body)


# ---------------------------------------------------------------- OpenAlex
OPENALEX_SELECT = "id,doi,display_name,authorships,publication_year,type,primary_location,is_retracted,biblio"


def openalex_by_doi(client: httpx.Client, doi: str) -> ProviderResult:
    url = f"https://api.openalex.org/works/doi:{quote(doi, safe='/')}"
    r, reason = _get(client, url, params=_openalex_params({"select": OPENALEX_SELECT}), headers=_headers())
    if r is None:
        return ProviderResult(UNAVAILABLE, "OpenAlex", detail=reason)
    if r.status_code == 404:
        return ProviderResult(NOT_FOUND, "OpenAlex")
    body = _json(r)
    if r.status_code != 200 or not isinstance(body, dict):
        return ProviderResult(UNAVAILABLE, "OpenAlex", detail=f"unexpected response {r.status_code}")
    return ProviderResult(OK, "OpenAlex", body)


def openalex_search(client: httpx.Client, query: str, rows: int = 10) -> ProviderResult:
    params = _openalex_params({"search": query, "per_page": rows, "select": OPENALEX_SELECT})
    r, reason = _get(client, "https://api.openalex.org/works", params=params, headers=_headers())
    if r is None:
        return ProviderResult(UNAVAILABLE, "OpenAlex", detail=reason)
    body = _json(r)
    if r.status_code != 200 or not isinstance(body, dict):
        return ProviderResult(UNAVAILABLE, "OpenAlex", detail=f"unexpected response {r.status_code}")
    return ProviderResult(OK, "OpenAlex", body.get("results") or [])
