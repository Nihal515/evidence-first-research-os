"""AI agents: the guards are plain code, so they are tested without calling a model.
The model is replaced by a stub that returns what a model might return, including
invented quotes and wrong numbers, to show the guards catch them."""
import importlib

import pytest
from fastapi.testclient import TestClient

from backend import ai
from backend import providers as p
from tests.test_verify import LECUN, LECUN_DOI, Fake

ABSTRACT = ("Deep learning allows computational models that are composed of multiple processing layers to learn "
            "representations of data with multiple levels of abstraction. These methods have dramatically improved "
            "the state-of-the-art in speech recognition, visual object recognition, object detection and many other "
            "domains. Home working led to a 13% performance increase in the call centre.")
def _inverted(text):
    index = {}
    for i, w in enumerate(text.split(" ")):
        index.setdefault(w, []).append(i)
    return index


OA = {"open_access": {"is_oa": False}, "best_oa_location": None, "abstract_inverted_index": _inverted(ABSTRACT)}


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'ai.db'}")
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("LLM_API_KEY", "test-key-not-real")
    from backend import db
    importlib.reload(db)
    from backend import app as app_module
    importlib.reload(app_module)
    return TestClient(app_module.app)


def stub(monkeypatch, answer):
    calls = []

    def fake(client, system, prompt, schema):
        calls.append(prompt)
        if isinstance(answer, Exception):
            raise answer
        return answer
    monkeypatch.setattr(ai, "generate_json", fake)
    return calls


def project_with_paper(api, monkeypatch):
    Fake(monkeypatch, work=LECUN, updates=[], open_access=OA)
    pid = api.post("/api/projects", json={"title": "Remote work", "question": "Does home working change performance?"}).json()["id"]
    rid = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI}).json()["id"]
    return pid, rid


# ------------------------------------------------------------------ guards
def test_quote_guard():
    assert ai.quote_in_source("led to a 13% performance increase", ABSTRACT)
    assert ai.quote_in_source("Home  working   led to a 13% Performance increase", ABSTRACT)  # spacing and case
    assert not ai.quote_in_source("led to a 31% performance increase", ABSTRACT)  # altered
    assert not ai.quote_in_source("Deep", ABSTRACT)  # too short to mean anything


def test_number_check():
    assert ai.number_check("Home working lifted performance by 31%.", "led to a 13% performance increase")["ok"] is False
    assert ai.number_check("Home working lifted performance by 13%.", "led to a 13% performance increase")["ok"] is True
    assert ai.number_check("In 2015 it rose by 13 percent", "a 13% increase") ["ok"] is True  # years are ignored
    assert ai.number_check("It improved.", "a 13% increase") is None


# ------------------------------------------------------------------ Planner
def test_planner_suggests_terms_and_drops_bad_ones(api, monkeypatch):
    pid, _ = project_with_paper(api, monkeypatch)
    stub(monkeypatch, {"queries": [{"query": "remote work productivity", "why": "core topic"},
                                   {"query": "10.1093/qje/qju032", "why": "a DOI is not a search term"},
                                   {"query": "remote work productivity", "why": "repeat"},
                                   {"query": "telework randomized experiment", "why": "method angle"}]})
    r = api.post(f"/api/projects/{pid}/ai/search-terms", json={}).json()
    assert r["label"] == "ai_suggestion" and r["agent"] == "Planner"
    assert [q["query"] for q in r["queries"]] == ["remote work productivity", "telework randomized experiment"]
    audit = api.get(f"/api/projects/{pid}/audit").json()
    assert any(e["actor"] == "ai" and e["event"] == "AI_SEARCH_TERMS_SUGGESTED" for e in audit)


# ------------------------------------------------------------------ Reader
def test_reader_keeps_only_exact_quotes(api, monkeypatch):
    pid, rid = project_with_paper(api, monkeypatch)
    stub(monkeypatch, {"aim": ["Deep learning allows computational models that are composed of multiple processing layers"],
                       "method": ["We surveyed 10,000 engineers."],  # invented: not in the abstract
                       "findings": ["Home working led to a 13% performance increase in the call centre."],
                       "limits": []})
    ref = api.post(f"/api/projects/{pid}/references/{rid}/ai/read").json()
    reading = ref["ai_reading"]
    assert reading["label"] == "ai_suggestion" and reading["kept"] == 2 and reading["dropped"] == 1
    assert reading["sections"]["method"] == [] and reading["sections"]["findings"]
    # a second request uses the stored reading (no extra AI call)
    calls = stub(monkeypatch, {"aim": [], "method": [], "findings": [], "limits": []})
    again = api.post(f"/api/projects/{pid}/references/{rid}/ai/read").json()
    assert again["ai_reading"]["kept"] == 2 and calls == []


# ------------------------------------------------------------------ Challenger
def test_challenger_code_overrules_wrong_numbers(api, monkeypatch):
    pid, rid = project_with_paper(api, monkeypatch)
    stub(monkeypatch, {"verdict": "supported", "quote": "Home working led to a 13% performance increase",
                       "explanation": "The paper reports a performance increase."})
    r = api.post(f"/api/projects/{pid}/references/{rid}/ai/claim", json={"claim": "Home working lifted performance by 31%."}).json()
    assert r["verdict"] == "contradicted" and r["quote_ok"] is True and r["numbers"]["ok"] is False
    assert "overruled" in r["guard"]


def test_challenger_supported_when_numbers_match(api, monkeypatch):
    pid, rid = project_with_paper(api, monkeypatch)
    stub(monkeypatch, {"verdict": "supported", "quote": "Home working led to a 13% performance increase",
                       "explanation": "Same number and direction."})
    r = api.post(f"/api/projects/{pid}/references/{rid}/ai/claim", json={"claim": "Home working lifted performance by 13%."}).json()
    assert r["verdict"] == "supported" and r["numbers"]["ok"] is True and r["label"] == "ai_suggestion"


def test_challenger_discards_an_invented_quote(api, monkeypatch):
    pid, rid = project_with_paper(api, monkeypatch)
    stub(monkeypatch, {"verdict": "supported", "quote": "Remote workers were 31% more productive",
                       "explanation": "It says so."})
    r = api.post(f"/api/projects/{pid}/references/{rid}/ai/claim", json={"claim": "Home working lifted performance by 31%."}).json()
    assert r["verdict"] == "discarded" and r["quote_ok"] is False


# ------------------------------------------------------------------ the AI level, at the server
def test_ai_level_is_enforced_at_the_server(api, monkeypatch):
    pid, rid = project_with_paper(api, monkeypatch)
    stub(monkeypatch, {"queries": [{"query": "remote work", "why": "x"}]})
    assert api.get(f"/api/projects/{pid}").json()["ai_level"] == ai.DEFAULT_LEVEL
    assert api.put(f"/api/projects/{pid}/ai-level", json={"level": 1}).json()["ai_level"] == 1
    assert api.post(f"/api/projects/{pid}/ai/search-terms", json={}).status_code == 200
    r = api.post(f"/api/projects/{pid}/references/{rid}/ai/read")
    assert r.status_code == 403 and "level 2" in r.json()["detail"]
    assert api.post(f"/api/projects/{pid}/references/{rid}/ai/claim", json={"claim": "Home working helps."}).status_code == 403
    api.put(f"/api/projects/{pid}/ai-level", json={"level": 0})
    assert api.post(f"/api/projects/{pid}/ai/search-terms", json={}).status_code == 403
    assert api.put(f"/api/projects/{pid}/ai-level", json={"level": 4}).status_code == 422


def test_ai_never_reads_an_unverified_source(api, monkeypatch):
    Fake(monkeypatch, work=p.UNAVAILABLE, handle=p.UNAVAILABLE, oa_doi=p.UNAVAILABLE, updates=[])
    pid = api.post("/api/projects", json={"title": "t"}).json()["id"]
    ref = api.post(f"/api/projects/{pid}/references", json={"mode": "doi", "doi": LECUN_DOI}).json()
    assert ref["label"] == "not_yet_verified"
    stub(monkeypatch, {"aim": [], "method": [], "findings": [], "limits": []})
    r = api.post(f"/api/projects/{pid}/references/{ref['id']}/ai/read")
    assert r.status_code == 409 and "Verified" in r.json()["detail"]


def test_ai_outage_changes_nothing(api, monkeypatch):
    pid, rid = project_with_paper(api, monkeypatch)
    stub(monkeypatch, ai.AIUnavailable("The free AI quota is busy right now. Wait a minute and try again."))
    r = api.post(f"/api/projects/{pid}/references/{rid}/ai/read")
    assert r.status_code == 503 and "quota" in r.json()["detail"]
    ref = api.get(f"/api/projects/{pid}/references").json()[0]
    assert ref["label"] == "verified" and ref["ai_reading"] is None


def test_summary_counts_ai_use(api, monkeypatch):
    pid, rid = project_with_paper(api, monkeypatch)
    stub(monkeypatch, {"queries": [{"query": "remote work", "why": "x"}]})
    api.post(f"/api/projects/{pid}/ai/search-terms", json={})
    s = api.get(f"/api/projects/{pid}/summary").json()
    assert s["ai_runs"] == 1 and s["ai_features"]["search_terms"] == 1 and s["ai_level"] == ai.DEFAULT_LEVEL


def test_without_a_key_ai_is_refused(api, monkeypatch):
    pid, _ = project_with_paper(api, monkeypatch)
    monkeypatch.delenv("LLM_API_KEY")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    r = api.post(f"/api/projects/{pid}/ai/search-terms", json={})
    assert r.status_code == 503 and api.get("/api/ai").json()["configured"] is False


def test_first_good_model_wins_and_busy_models_are_skipped(monkeypatch):
    """Free-tier models are often overloaded (503) or out of quota (429): the answer
    comes from whichever model answers, and a backup Groq key joins the race."""
    import json as _json
    import httpx

    def handler(req):
        u = str(req.url)
        if u.endswith("/models?pageSize=200"):
            names = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3-flash-preview", "gemini-omni-1.2-flash", "gemini-2.5-flash"]
            return httpx.Response(200, json={"models": [{"name": f"models/{n}", "supportedGenerationMethods": ["generateContent"]} for n in names]})
        if "3.8" in u:
            return httpx.Response(503, json={"error": {"message": "high demand"}})
        if "3.7" in u:
            return httpx.Response(429, json={"error": {"message": "quota"}})
        if "3-flash-preview" in u:
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": _json.dumps({"ok": 1})}]}}]})
        raise AssertionError(f"retired or quota-less model was asked: {u}")
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setattr(ai, "_working_model", None)
    monkeypatch.setattr(ai, "_model_list", (0.0, []))
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        assert ai.generate_json(c, "s", "p", {}) == {"ok": 1}
    assert ai._working_model == "Google Gemini (gemini-3-flash-preview)"


def test_all_models_busy_is_reported_not_guessed(monkeypatch):
    import httpx

    def handler(req):
        if str(req.url).endswith("/models?pageSize=200"):
            return httpx.Response(200, json={"models": [{"name": "models/gemini-3.8-flash", "supportedGenerationMethods": ["generateContent"]}]})
        return httpx.Response(503, json={"error": {"message": "high demand"}})
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.setattr(ai, "_working_model", None)
    monkeypatch.setattr(ai, "_model_list", (0.0, []))
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(ai.AIUnavailable, match="overloaded"):
            ai.generate_json(c, "s", "p", {})


def test_nvidia_nemotron_backup_answers_when_gemini_is_busy(monkeypatch):
    """With NVIDIA_API_KEY set, Nemotron joins the race. Its embedding and safety models are
    not used for chat, and reasoning text or code fences around the JSON are removed."""
    import json as _json
    import httpx
    asked = []

    def handler(req):
        u = str(req.url)
        if "generativelanguage" in u:
            if u.endswith("/models?pageSize=200"):
                return httpx.Response(200, json={"models": [{"name": "models/gemini-3.8-flash", "supportedGenerationMethods": ["generateContent"]}]})
            return httpx.Response(503, json={"error": {"message": "high demand"}})
        if u.endswith("/v1/models"):
            ids = ["nvidia/llama-nemotron-embed-1b-v2", "nvidia/nemotron-content-safety", "nvidia/nemotron-3.5-nano-30b",
                   "nvidia/nemotron-3.5-super-120b", "meta/llama-3.3-70b-instruct"]
            return httpx.Response(200, json={"data": [{"id": i} for i in ids]})
        body = _json.loads(req.content)
        asked.append(body["model"])
        assert req.headers["Authorization"] == "Bearer nvapi-test" and "response_format" not in body
        text = "<think>checking</think>```json\n" + _json.dumps({"ok": 2}) + "\n```"
        return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_MODEL", raising=False)
    monkeypatch.setattr(ai, "_working_model", None)
    monkeypatch.setattr(ai, "_model_list", (0.0, []))
    monkeypatch.setattr(ai, "_nvidia_list", (0.0, []))
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        assert ai.generate_json(c, "s", "p", {}) == {"ok": 2}
    assert ai._working_model.startswith("NVIDIA (nvidia/nemotron-3.5-")
    assert not any("embed" in m or "safety" in m for m in asked)
