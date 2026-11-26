"""Checks that the API keys saved in Vercel actually work — without ever
returning, logging or echoing a key.

Each key is tested with the cheapest read-only call its provider offers:

* OpenAlex  GET https://api.openalex.org/rate-limit          (401 when the key is wrong)
* Groq      GET https://api.groq.com/openai/v1/models        (401 when the key is wrong)
* Gemini    GET https://generativelanguage.googleapis.com/v1beta/models  (400 API_KEY_INVALID)

Statuses: ``valid`` · ``invalid`` · ``not_configured`` · ``unavailable`` (the
provider could not be reached, so we cannot say) · ``rate_limited`` (the key was
accepted but its free quota is used up for now).
"""
from __future__ import annotations

import os
import time
from typing import Callable, Optional

import httpx

from .verify import now_iso

LLM_PROVIDERS = ("groq", "gemini")
CACHE_SECONDS = 60
_cache: dict = {"at": 0.0, "result": None}

OPENALEX_URL = "https://api.openalex.org/rate-limit"
GROQ_URL = "https://api.groq.com/openai/v1/models"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def _call(client: httpx.Client, url: str, *, params=None, headers=None) -> Optional[httpx.Response]:
    try:
        return client.get(url, params=params, headers=headers)
    except httpx.HTTPError:
        return None


def _result(status: str, detail: str, **extra) -> dict:
    return {"configured": status != "not_configured", "status": status, "detail": detail, **extra}


def check_openalex(client: httpx.Client) -> dict:
    key = _env("OPENALEX_API_KEY")
    if not key:
        return _result("not_configured", "No OPENALEX_API_KEY is saved. The site still works, with a small daily budget.")
    r = _call(client, OPENALEX_URL, params={"api_key": key})
    if r is None or r.status_code >= 500:
        return _result("unavailable", "OpenAlex could not be reached, so the key could not be tested right now.")
    if r.status_code in (401, 403):
        return _result("invalid", "OpenAlex rejected this key. Copy it again from openalex.org/settings/api. "
                                  "If you just created it, check your email for the activation link.")
    if r.status_code == 429:
        return _result("rate_limited", "OpenAlex accepted the key but today's free budget is used up.")
    if r.status_code == 200:
        budget = None
        try:
            budget = r.json().get("rate_limit", {}).get("daily_budget_usd")
        except ValueError:
            pass
        detail = "OpenAlex accepted the key."
        if isinstance(budget, (int, float)):
            detail += f" Daily free budget: ${budget:g}."
        return _result("valid", detail)
    return _result("unavailable", f"OpenAlex gave an unexpected answer (HTTP {r.status_code}).")


def _key_shape_hint(provider: str, key: str) -> str:
    """A plain-English hint when a key clearly belongs to a different service.
    Only well-known public prefixes are inspected; the key itself is never returned."""
    if provider == "groq":
        if key.startswith("xai-"):
            return " This looks like an xAI (Grok, with a K) key. Groq keys come from console.groq.com and usually start with gsk_."
        if key.startswith(("AIza", "AQ.")):
            return " This looks like a Google Gemini key. Set LLM_PROVIDER to gemini, or use a Groq key from console.groq.com."
    if provider == "gemini":
        if key.startswith("gsk_"):
            return " This looks like a Groq key. Set LLM_PROVIDER to groq, or use a Gemini key from aistudio.google.com."
        if key.startswith("xai-"):
            return " This looks like an xAI (Grok) key. Gemini keys come from aistudio.google.com."
    return ""


def _check_llm_key(client: httpx.Client, provider: str, key: str) -> dict:
    if provider == "groq":
        r = _call(client, GROQ_URL, headers={"Authorization": f"Bearer {key}"})
        name = "Groq"
    else:
        r = _call(client, GEMINI_URL, params={"pageSize": 1}, headers={"x-goog-api-key": key})
        name = "Gemini"
    hint = _key_shape_hint(provider, key)
    if r is None or r.status_code >= 500:
        return _result("unavailable", f"{name} could not be reached, so the key could not be tested right now.",
                       provider=provider)
    if r.status_code == 200:
        return _result("valid", f"{name} accepted the key.", provider=provider)
    if r.status_code == 429:
        return _result("rate_limited", f"{name} accepted the key but its free quota is used up for the moment.",
                       provider=provider)
    if r.status_code in (400, 401, 403):
        return _result("invalid", f"{name} rejected this key.{hint}", provider=provider)
    return _result("unavailable", f"{name} gave an unexpected answer (HTTP {r.status_code}).", provider=provider)


def _looks_like_a_key(value: str) -> bool:
    return len(value) > 12 or any(ch in value for ch in "._-/")


def check_llm(client: httpx.Client) -> dict:
    raw_provider = _env("LLM_PROVIDER")
    provider = raw_provider.lower()
    # Only ever echo the provider when it is one of the two allowed words: a
    # wrong value may be a pasted secret, so it is never returned.
    safe_provider = provider if provider in LLM_PROVIDERS else None
    key = _env("LLM_API_KEY")
    if not key:
        return _result("not_configured", "No LLM_API_KEY is saved yet.", provider=safe_provider)
    if key.lower() in LLM_PROVIDERS:
        return _result("invalid", f"LLM_API_KEY holds the word '{key.lower()}' instead of a key. The two values "
                                  "look swapped: LLM_PROVIDER should be the word, LLM_API_KEY the key.",
                       provider=safe_provider)
    if safe_provider is None:
        if raw_provider and _looks_like_a_key(raw_provider):
            detail = ("LLM_PROVIDER holds something that looks like an API key. It should be just the word "
                      "groq or gemini; the key itself belongs in LLM_API_KEY.")
        else:
            detail = "LLM_PROVIDER must be groq or gemini (small letters)."
        return _result("invalid", detail, provider=None)
    return _check_llm_key(client, provider, key)


def check_llm_backup(client: httpx.Client) -> dict:
    key = _env("GEMINI_API_KEY")
    if not key:
        return _result("not_configured", "No backup GEMINI_API_KEY is saved (optional).", provider="gemini")
    return _check_llm_key(client, "gemini", key)


def check_groq_backup(client: httpx.Client) -> dict:
    key = _env("GROQ_API_KEY")
    if not key:
        return _result("not_configured", "No backup GROQ_API_KEY is saved (optional, free from console.groq.com).",
                       provider="groq")
    return _check_llm_key(client, "groq", key)


def check_nvidia_backup(client: httpx.Client) -> dict:
    """NVIDIA API catalog (build.nvidia.com). Its model list is public, so the key is tested
    with a one-token request to a Nemotron model."""
    from . import ai
    key = _env("NVIDIA_API_KEY")
    if not key:
        return _result("not_configured", "No backup NVIDIA_API_KEY is saved (optional).", provider="nvidia")
    if not key.startswith("nvapi-"):
        return _result("invalid", "NVIDIA API keys start with nvapi-. Copy the key again from build.nvidia.com "
                                  "(Get API Key), and save only the key itself.", provider="nvidia")
    model = ai.nvidia_models(client, key)[0]
    try:
        r = client.post(f"{ai.NVIDIA_BASE}/chat/completions", headers={"Authorization": f"Bearer {key}"},
                        json={"model": model, "max_tokens": 1, "messages": [{"role": "user", "content": "ok"}]},
                        timeout=15.0)
    except httpx.HTTPError:
        r = None
    if r is None or r.status_code >= 500:
        return _result("unavailable", "NVIDIA could not be reached, so the key could not be tested right now.",
                       provider="nvidia", model=model)
    if r.status_code == 200:
        return _result("valid", f"NVIDIA accepted the key ({model}).", provider="nvidia", model=model)
    if r.status_code == 429:
        return _result("rate_limited", "NVIDIA accepted the key but its free quota is used up for the moment.",
                       provider="nvidia", model=model)
    if r.status_code in (401, 403):
        return _result("invalid", "NVIDIA rejected this key. Create a new one at build.nvidia.com.", provider="nvidia")
    return _result("unavailable", f"NVIDIA gave an unexpected answer (HTTP {r.status_code}) for {model}.",
                   provider="nvidia", model=model)


def check_auth(client: httpx.Client) -> dict:
    """Sign-in service: reachable, and publishing the public keys used to verify tokens."""
    base = (os.getenv("NEON_AUTH_BASE_URL") or os.getenv("VITE_NEON_AUTH_URL") or "").strip().rstrip("/")
    if not base:
        return _result("not_configured", "Neon Auth is not connected (NEON_AUTH_BASE_URL is missing).")
    r = _call(client, f"{base}/.well-known/jwks.json")
    if r is None or r.status_code >= 500:
        return _result("unavailable", "Neon Auth could not be reached right now.")
    if r.status_code != 200:
        return _result("invalid", f"Neon Auth answered HTTP {r.status_code} for its signing keys. Check that Auth is enabled in Neon.")
    try:
        n = len([k for k in r.json().get("keys", []) if isinstance(k, dict)])
    except ValueError:
        n = 0
    if not n:
        return _result("invalid", "Neon Auth published no signing keys. Check that Auth is enabled in Neon.")
    return _result("valid", f"Neon Auth is reachable and publishes {n} signing key{'s' if n != 1 else ''}.")


def check_all(make_client: Callable[[], httpx.Client], *, use_cache: bool = True) -> dict:
    now = time.monotonic()
    if use_cache and _cache["result"] is not None and now - _cache["at"] < CACHE_SECONDS:
        return _cache["result"]
    with make_client() as client:
        result = {
            "checked_at": now_iso(),
            "openalex": check_openalex(client),
            "llm": check_llm(client),
            "llm_backup": check_llm_backup(client),
            "llm_backup_groq": check_groq_backup(client),
            "llm_backup_nvidia": check_nvidia_backup(client),
            "sign_in": check_auth(client),
        }
    _cache.update(at=now, result=result)
    return result
