"""Free legal copies (open access) and abstracts, from OpenAlex. Plain code, no AI.

OpenAlex reports the best open-access location for a work: a PDF or landing page in
a repository or on the publisher's site, with its version (submitted = preprint,
accepted = author manuscript, published = the version of record) and licence. We
show exactly that, so a student knows whether the free copy is the version they cite.
"""
from __future__ import annotations

from typing import Optional

from . import providers
from .verify import now_iso

VERSION_TEXT = {
    "publishedVersion": "published version",
    "acceptedVersion": "accepted manuscript",
    "submittedVersion": "preprint (submitted version)",
}


def abstract_from_inverted_index(index: Optional[dict]) -> Optional[str]:
    """OpenAlex stores abstracts as {word: [positions]}; rebuild the text."""
    if not isinstance(index, dict) or not index:
        return None
    positions: list[tuple[int, str]] = []
    for word, places in index.items():
        for pos in places or []:
            if isinstance(pos, int):
                positions.append((pos, word))
    if not positions:
        return None
    text = " ".join(w for _, w in sorted(positions)).strip()
    return text[:20000] or None


def find_free_copy(client, doi: Optional[str]) -> tuple[dict, Optional[str]]:
    """Returns (free_copy_info, abstract). free_copy_info["status"] is one of:
    found · none · unavailable · no_doi."""
    checked = now_iso()
    if not doi:
        return {"status": "no_doi", "checked_at": checked}, None
    res = providers.openalex_open_access(client, doi)
    if res.status == providers.UNAVAILABLE:
        return {"status": "unavailable", "detail": "OpenAlex could not be reached.", "checked_at": checked}, None
    if res.status == providers.NOT_FOUND:
        return {"status": "none", "checked_at": checked}, None
    body = res.data or {}
    abstract = abstract_from_inverted_index(body.get("abstract_inverted_index"))
    best = body.get("best_oa_location") or {}
    oa = body.get("open_access") or {}
    url = best.get("pdf_url") or best.get("landing_page_url") or oa.get("oa_url")
    if not (oa.get("is_oa") or best.get("is_oa")) or not url:
        return {"status": "none", "checked_at": checked}, abstract
    source = best.get("source") or {}
    version = best.get("version")
    return {
        "status": "found",
        "url": url,
        "is_pdf": bool(best.get("pdf_url")) and url == best.get("pdf_url"),
        "version": version,
        "version_text": VERSION_TEXT.get(version or "", "version not stated"),
        "host": source.get("display_name") or source.get("host_organization_name") or "",
        "host_type": source.get("type") or "",
        "license": best.get("license") or "",
        "oa_status": oa.get("oa_status") or "",
        "provider": "OpenAlex",
        "checked_at": checked,
    }, abstract
