"""Sign-in: JWT verification against Neon Auth's JWKS (EdDSA), project ownership on
every route, claiming a guest library, guest mode unchanged, and the same-origin
proxy that turns Neon Auth's cookie into a first-party cookie."""
import base64
import importlib
import json
import time

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

BASE = "https://ep-test-123.neonauth.example.aws.neon.tech/neondb/auth"
ORIGIN = "https://ep-test-123.neonauth.example.aws.neon.tech"
KEY = Ed25519PrivateKey.generate()
OTHER_KEY = Ed25519PrivateKey.generate()


def jwk_for(key, kid):
    raw = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return {"kty": "OKP", "crv": "Ed25519", "x": base64.urlsafe_b64encode(raw).rstrip(b"=").decode(), "kid": kid, "alg": "EdDSA"}


def token(sub="user-1", *, key=KEY, kid="k1", iss=ORIGIN, aud=ORIGIN, exp_in=900, **extra):
    now = int(time.time())
    claims = {"sub": sub, "id": sub, "email": f"{sub}@example.com", "iat": now, "exp": now + exp_in, "iss": iss, "aud": aud, **extra}
    return jwt.encode(claims, key, algorithm="EdDSA", headers={"kid": kid})


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'auth.db'}")
    monkeypatch.setenv("NEON_AUTH_BASE_URL", BASE)
    from backend import db
    importlib.reload(db)
    from backend import auth
    importlib.reload(auth)
    from backend import app as app_module
    importlib.reload(app_module)
    fetches = []

    def fake_get(url, timeout=None):
        fetches.append(url)
        assert url == f"{BASE}/.well-known/jwks.json"
        return httpx.Response(200, json={"keys": [jwk_for(KEY, "k1")]}, request=httpx.Request("GET", url))

    monkeypatch.setattr(auth.httpx, "get", fake_get)
    return TestClient(app_module.app), auth, fetches


def h(tok):
    return {"Authorization": f"Bearer {tok}"}


# ------------------------------------------------------------------ token verification
def test_valid_token_is_accepted_and_jwks_cached(env):
    api, auth, fetches = env
    me = api.get("/api/me", headers=h(token())).json()
    assert me["signed_in"] and me["user"]["id"] == "user-1" and me["user"]["email"] == "user-1@example.com"
    api.get("/api/me", headers=h(token()))
    assert len(fetches) == 1  # keys cached


@pytest.mark.parametrize("bad", [
    token(exp_in=-120),                       # expired
    token(aud="https://evil.example"),        # wrong audience
    token(iss="https://evil.example"),        # wrong issuer
    token(key=OTHER_KEY),                     # signed by someone else's key
    token(kid="unknown"),                     # key not in the JWKS
    token(banned=True),                       # disabled account
    "not.a.jwt",
])
def test_bad_tokens_are_rejected_with_401(env, bad):
    api, auth, _ = env
    r = api.get("/api/me", headers=h(bad))
    assert r.status_code == 401 and "sign in again" in r.json()["detail"]


def test_algorithm_confusion_is_rejected(env):
    api, auth, _ = env
    hs = jwt.encode({"sub": "attacker", "iss": ORIGIN, "aud": ORIGIN, "exp": int(time.time()) + 60, "iat": int(time.time())},
                    "a-long-enough-test-secret-for-hs256-0123456789", algorithm="HS256", headers={"kid": "k1"})
    none = base64.urlsafe_b64encode(json.dumps({"alg": "none", "kid": "k1"}).encode()).rstrip(b"=").decode() + "." + \
        base64.urlsafe_b64encode(json.dumps({"sub": "attacker"}).encode()).rstrip(b"=").decode() + "."
    for t in (hs, none):
        assert api.get("/api/me", headers=h(t)).status_code == 401


def test_no_token_is_a_guest(env):
    api, auth, _ = env
    assert api.get("/api/me").json() == {"signed_in": False, "user": None, "auth_configured": True}


# ------------------------------------------------------------------ ownership
def test_signed_in_projects_are_private(env):
    api, auth, _ = env
    pid = api.post("/api/projects", json={"title": "Mine"}, headers=h(token("alice"))).json()["id"]
    assert api.get(f"/api/projects/{pid}", headers=h(token("alice"))).json()["owned_by_you"] is True
    for headers in ({}, h(token("bob"))):  # guests and other accounts see nothing
        assert api.get(f"/api/projects/{pid}", headers=headers).status_code == 404
        assert api.get(f"/api/projects/{pid}/library", headers=headers).status_code == 404
        assert api.post(f"/api/projects/{pid}/collections", json={"name": "x"}, headers=headers).status_code == 404
        assert api.get(f"/api/projects/{pid}/summary", headers=headers).status_code == 404
    assert [p["id"] for p in api.get("/api/me/projects", headers=h(token("alice"))).json()] == [pid]
    assert api.get("/api/me/projects", headers=h(token("bob"))).json() == []
    body = api.get(f"/api/projects/{pid}", headers=h(token("alice"))).json()
    assert "owner_id" not in body  # the account id is never sent to the browser


def test_guest_mode_is_unchanged(env):
    api, auth, _ = env
    pid = api.post("/api/projects", json={"title": "Guest"}).json()["id"]
    body = api.get(f"/api/projects/{pid}").json()
    assert body["owned"] is False and body["owned_by_you"] is False
    assert api.get(f"/api/projects/{pid}/library").status_code == 200


def test_claim_a_guest_library(env):
    api, auth, _ = env
    pid = api.post("/api/projects", json={"title": "Guest work"}).json()["id"]
    assert api.post(f"/api/projects/{pid}/claim").status_code == 401  # must be signed in
    claimed = api.post(f"/api/projects/{pid}/claim", headers=h(token("alice"))).json()
    assert claimed["owned_by_you"] is True
    assert api.get(f"/api/projects/{pid}").status_code == 404  # no longer open to guests
    assert api.post(f"/api/projects/{pid}/claim", headers=h(token("bob"))).status_code == 404  # cannot be taken over
    events = [e["event"] for e in api.get(f"/api/projects/{pid}/audit", headers=h(token("alice"))).json()]
    assert "PROJECT_SAVED_TO_ACCOUNT" in events


# ------------------------------------------------------------------ same-origin proxy
def test_set_cookie_becomes_first_party(env):
    _, auth, _ = env
    out = auth.rewrite_set_cookie("__Secure-neon-auth.session_token=abc; Domain=ep-test-123.neonauth.example; "
                                  "Path=/neondb/auth; HttpOnly; Secure; SameSite=None; Max-Age=604800")
    assert out.startswith("__Secure-neon-auth.session_token=abc; Path=/")
    assert "Domain" not in out and "/neondb/auth" not in out and "HttpOnly" in out and "Secure" in out


def test_proxy_forwards_safely(env, monkeypatch):
    api, auth, _ = env
    seen = {}

    async def fake_request(self, method, url, params=None, content=None, headers=None):
        seen.update(method=method, url=url, headers={k.lower(): v for k, v in (headers or {}).items()}, body=content)
        return httpx.Response(200, json={"session": {"id": "s"}, "user": {"id": "u"}},
                              headers=[("set-cookie", "neon-auth.session_token=xyz; Domain=neon.tech; Path=/neondb/auth; HttpOnly; Secure; SameSite=Lax"),
                                       ("set-auth-jwt", "header.payload.sig"), ("x-internal", "secret")])

    monkeypatch.setattr(auth.httpx.AsyncClient, "request", fake_request)
    r = api.post("/api/auth/sign-in/email", json={"email": "a@b.c", "password": "test-only"},
                 headers={"Origin": "https://evidence-first-research-os.vercel.app", "Cookie": "a=1", "X-Forwarded-Host": "evil"})
    assert seen["url"] == f"{BASE}/sign-in/email" and seen["method"] == "POST"
    assert seen["headers"]["origin"] == "https://evidence-first-research-os.vercel.app" and seen["headers"]["cookie"] == "a=1"
    assert "x-forwarded-host" not in seen["headers"] and "host" not in seen["headers"]
    assert r.status_code == 200 and r.headers["set-auth-jwt"] == "header.payload.sig" and "x-internal" not in r.headers
    assert r.headers["set-cookie"].startswith("neon-auth.session_token=xyz; Path=/") and "Domain" not in r.headers["set-cookie"]
    assert r.headers["cache-control"] == "no-store"


def test_proxy_rejects_odd_paths_and_needs_configuration(env, monkeypatch):
    api, auth, _ = env
    assert api.get("/api/auth/..%2F..%2Fadmin").status_code == 404
    monkeypatch.delenv("NEON_AUTH_BASE_URL")
    monkeypatch.delenv("VITE_NEON_AUTH_URL", raising=False)
    assert api.get("/api/auth/get-session").status_code == 503
