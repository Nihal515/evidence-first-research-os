"""Key check: each saved key is tested with its provider, the answer is one of
valid / invalid / not_configured / unavailable / rate_limited, and no key is
ever returned. Providers are simulated with httpx.MockTransport."""
import json

import httpx
import pytest

from backend import keycheck

GROQ_KEY = "gsk_TESTONLY_groq_key_value_123"
XAI_KEY = "xai-TESTONLY_grok_key_value_456"
GEMINI_KEY = "AIzaTESTONLY_gemini_key_value_789"
OPENALEX_KEY = "TESTONLY_openalex_key_value_000"


def client_factory(handler, calls=None):
    def make():
        def wrapped(request):
            if calls is not None:
                calls.append(str(request.url))
            return handler(request)
        return httpx.Client(transport=httpx.MockTransport(wrapped))
    return make


def provider_router(openalex=200, groq=200, gemini=200, budget=1):
    def handler(request: httpx.Request):
        host = request.url.host
        if host == "api.openalex.org":
            body = {"rate_limit": {"daily_budget_usd": budget}} if openalex == 200 else {"error": "Invalid"}
            return httpx.Response(openalex, json=body)
        if host == "api.groq.com":
            return httpx.Response(groq, json={"data": []} if groq == 200 else {"error": {"code": "invalid_api_key"}})
        if host == "auth.example.test":
            return httpx.Response(200, json={"keys": [{"kty": "OKP", "kid": "k"}]})
        if host == "generativelanguage.googleapis.com":
            return httpx.Response(gemini, json={"models": []} if gemini == 200 else {"error": {"code": gemini}})
        raise AssertionError(f"unexpected host {host}")
    return handler


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("OPENALEX_API_KEY", "LLM_API_KEY", "LLM_PROVIDER", "GEMINI_API_KEY", "NEON_AUTH_BASE_URL", "VITE_NEON_AUTH_URL"):
        monkeypatch.delenv(name, raising=False)
    keycheck._cache.update(at=0.0, result=None)


def run(handler):
    return keycheck.check_all(client_factory(handler), use_cache=False)


def test_nothing_saved_means_not_configured_and_no_network_calls():
    calls = []
    out = keycheck.check_all(client_factory(provider_router(), calls), use_cache=False)
    assert out["openalex"]["status"] == "not_configured"
    assert out["llm"]["status"] == "not_configured"
    assert out["llm_backup"]["status"] == "not_configured"
    assert calls == []


def test_all_keys_valid(monkeypatch):
    monkeypatch.setenv("OPENALEX_API_KEY", OPENALEX_KEY)
    monkeypatch.setenv("LLM_API_KEY", GROQ_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    monkeypatch.setenv("GEMINI_API_KEY", GEMINI_KEY)
    out = run(provider_router())
    assert out["openalex"]["status"] == "valid" and "$1" in out["openalex"]["detail"]
    assert out["llm"] == {"configured": True, "status": "valid", "detail": "Groq accepted the key.", "provider": "groq"}
    assert out["llm_backup"]["status"] == "valid"


def test_no_key_is_ever_returned(monkeypatch):
    monkeypatch.setenv("OPENALEX_API_KEY", OPENALEX_KEY)
    monkeypatch.setenv("LLM_API_KEY", XAI_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    monkeypatch.setenv("GEMINI_API_KEY", GEMINI_KEY)
    for codes in ({}, {"openalex": 401, "groq": 401, "gemini": 400}, {"openalex": 503, "groq": 503, "gemini": 503}):
        text = json.dumps(run(provider_router(**codes)))
        for key in (OPENALEX_KEY, XAI_KEY, GEMINI_KEY, "TESTONLY"):
            assert key not in text


def test_wrong_openalex_key_is_invalid(monkeypatch):
    monkeypatch.setenv("OPENALEX_API_KEY", OPENALEX_KEY)
    out = run(provider_router(openalex=401))
    assert out["openalex"]["status"] == "invalid"
    assert "openalex.org/settings/api" in out["openalex"]["detail"]


def test_grok_key_saved_as_groq_is_invalid_with_a_clear_hint(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", XAI_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    out = run(provider_router(groq=401))
    assert out["llm"]["status"] == "invalid"
    assert "Grok, with a K" in out["llm"]["detail"] and "console.groq.com" in out["llm"]["detail"]


def test_gemini_key_with_groq_provider_gets_a_hint(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", GEMINI_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    out = run(provider_router(groq=401))
    assert out["llm"]["status"] == "invalid" and "LLM_PROVIDER to gemini" in out["llm"]["detail"]


def test_provider_name_is_case_and_space_tolerant(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", GEMINI_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "  Gemini ")
    out = run(provider_router())
    assert out["llm"]["status"] == "valid" and out["llm"]["provider"] == "gemini"


def test_unknown_provider_is_reported_without_calling_anyone(monkeypatch):
    calls = []
    monkeypatch.setenv("LLM_API_KEY", GROQ_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "grok")
    out = keycheck.check_all(client_factory(provider_router(), calls), use_cache=False)
    assert out["llm"]["status"] == "invalid" and "groq or gemini" in out["llm"]["detail"]
    assert calls == []


@pytest.mark.parametrize("with_key", [True, False])
def test_a_key_pasted_into_llm_provider_is_never_echoed(monkeypatch, with_key):
    pasted = "AQ.TESTONLY_Pasted-Into_Provider_box_123"
    monkeypatch.setenv("LLM_PROVIDER", pasted)
    if with_key:
        monkeypatch.setenv("LLM_API_KEY", GROQ_KEY)
    out = run(provider_router())
    text = json.dumps(out).lower()
    assert "testonly" not in text and "pasted" not in text
    assert out["llm"]["provider"] is None
    if with_key:
        assert out["llm"]["status"] == "invalid" and "looks like an API key" in out["llm"]["detail"]


def test_swapped_provider_and_key_are_detected(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", GEMINI_KEY)
    monkeypatch.setenv("LLM_API_KEY", "gemini")
    out = run(provider_router())
    assert out["llm"]["status"] == "invalid" and "swapped" in out["llm"]["detail"]
    assert "testonly" not in json.dumps(out).lower()


def test_gemini_rejects_bad_key_with_400(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", GEMINI_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    assert run(provider_router(gemini=400))["llm"]["status"] == "invalid"


def test_rate_limit_means_key_accepted(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", GROQ_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    assert run(provider_router(groq=429))["llm"]["status"] == "rate_limited"


def test_outage_or_network_error_is_unavailable_not_invalid(monkeypatch):
    monkeypatch.setenv("OPENALEX_API_KEY", OPENALEX_KEY)
    monkeypatch.setenv("LLM_API_KEY", GROQ_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    out = run(provider_router(openalex=503, groq=502))
    assert out["openalex"]["status"] == "unavailable" and out["llm"]["status"] == "unavailable"

    def boom(_request):
        raise httpx.ConnectTimeout("timed out")
    out = run(boom)
    assert out["openalex"]["status"] == "unavailable" and out["llm"]["status"] == "unavailable"


def test_results_are_cached_for_a_minute(monkeypatch):
    calls = []
    monkeypatch.setenv("LLM_API_KEY", GROQ_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    make = client_factory(provider_router(), calls)
    keycheck.check_all(make)
    keycheck.check_all(make)
    assert len(calls) == 1


def test_keys_endpoint(monkeypatch, tmp_path):
    import importlib
    from fastapi.testclient import TestClient
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'k.db'}")
    monkeypatch.setenv("LLM_API_KEY", GROQ_KEY)
    monkeypatch.setenv("LLM_PROVIDER", "groq")
    from backend import app as app_module
    importlib.reload(app_module)
    monkeypatch.setattr(app_module.providers, "make_client", client_factory(provider_router()))
    body = TestClient(app_module.app).get("/api/health/keys").json()
    assert body["llm"]["status"] == "valid" and body["openalex"]["status"] == "not_configured"
    assert GROQ_KEY not in json.dumps(body)



def test_sign_in_service_check(monkeypatch):
    assert run(provider_router())["sign_in"]["status"] == "not_configured"
    monkeypatch.setenv("NEON_AUTH_BASE_URL", "https://auth.example.test/neondb/auth")
    out = run(provider_router())["sign_in"]
    assert out["status"] == "valid" and "1 signing key" in out["detail"]
