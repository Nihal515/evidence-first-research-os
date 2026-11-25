"""Library logic that is plain code, not AI: duplicate detection and merge planning.

Two references are treated as possible duplicates when their titles are almost
identical (similarity >= 0.93 after normalising case, accents and punctuation),
their years are equal or one apart (preprint vs published version) or missing,
and — when both list authors — they share at least one family name. Same DOI
twice cannot happen (the database refuses it), so this catches the cases a DOI
check misses: a preprint and its journal version, or an unverified copy of a
verified paper.
"""
from __future__ import annotations

from difflib import SequenceMatcher
from typing import Iterable

from .records import norm

TITLE_THRESHOLD = 0.93


def _family_names(authors: Iterable[str]) -> set[str]:
    out = set()
    for a in authors or []:
        a = a.strip()
        if not a:
            continue
        # "LeCun, Yann" -> lecun ; "Yann LeCun" -> lecun
        family = a.split(",")[0] if "," in a else a.split()[-1]
        n = norm(family)
        if n:
            out.add(n)
    return out


def is_possible_duplicate(a: dict, b: dict) -> bool:
    ta, tb = norm(a.get("title")), norm(b.get("title"))
    if not ta or not tb:
        return False
    if SequenceMatcher(None, ta, tb).ratio() < TITLE_THRESHOLD:
        return False
    ya, yb = a.get("year"), b.get("year")
    if ya and yb and abs(int(ya) - int(yb)) > 1:
        return False
    fa, fb = _family_names(a.get("authors") or []), _family_names(b.get("authors") or [])
    if fa and fb and not (fa & fb):
        return False
    return True


def duplicate_groups(refs: list[dict]) -> list[list[dict]]:
    """Group active references that look like the same work. Each group is sorted
    so the best record to keep comes first: Verified before others, then the one
    with a DOI, then the earliest approved."""
    groups: list[list[dict]] = []
    used: set[str] = set()
    for i, a in enumerate(refs):
        if a["id"] in used:
            continue
        group = [a]
        for b in refs[i + 1:]:
            if b["id"] in used:
                continue
            if any(is_possible_duplicate(x, b) for x in group):
                group.append(b)
        if len(group) > 1:
            used.update(r["id"] for r in group)
            group.sort(key=lambda r: (r.get("label") != "verified", not r.get("doi"), r.get("approved_at") or ""))
            groups.append(group)
    return groups
