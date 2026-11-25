"""Sign-in with Neon Auth (managed Better Auth), done safely for a single-page app.

1. Same-origin proxy. The browser talks to /api/auth/* on our own domain, which is
   forwarded to Neon Auth (NEON_AUTH_BASE_URL). The session cookie Neon sets is
   re-issued for our domain, so it is a first-party cookie: browsers that block
   third-party cookies (Safari on iPhone) keep the user signed in. This is the same
   approach Neon's own Next.js SDK uses (a server route that proxies auth).

2. API identity. Neon Auth issues short-lived JWTs (EdDSA, 15 minutes). The browser
   sends one as "Authorization: Bearer …"; we verify its signature against Neon's
   public JWKS, plus issuer, audience and expiry, before trusting the user id.
   Nothing about a user is ever taken from the browser on trust.
"""
from __future__ import annotations

import os
import re
import time
from contextvars import ContextVar
from typing import Optional
from urllib.parse import urlparse

import httpx
import jwt
from fastapi import Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response

current_user: ContextVar[Optional[dict]] = ContextVar("current_user", default=None)

JWKS_TTL = 600  # seconds
_jwks_cache: dict = {"at": 0.0, "url": "", "keys": {}}

# Request headers passed through to Neon Auth (everything else is dropped).
FORWARD_REQUEST = {"content-type", "cookie", "origin", "referer", "user-agent", "accept", "accept-language",
                   "authorization"}
# Response headers passed back to the browser (Set-Cookie is rewritten separately).
FORWARD_RESPONSE = {"content-type", "set-auth-jwt", "set-auth-token", "cache-control", "location"}
SAFE_PATH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/_.\-]{0,200}$")


def auth_base() -> str:
    return (os.getenv("NEON_AUTH_BASE_URL") or os.getenv("VITE_NEON_AUTH_URL") or "").strip().rstrip("/")


def configured() -> bool:
    return bool(auth_base())


def _origin(url: str) -> str:
    u = urlparse(url)
    return f"{u.scheme}://{u.netloc}"


# ------------------------------------------------------------------ JWT verification
class TokenError(Exception):
    pass


def _fetch_jwks(force: bool = False) -> dict:
    url = f"{auth_base()}/.well-known/jwks.json"
    now = time.monotonic()
    if not force and _jwks_cache["url"] == url and now - _jwks_cache["at"] < JWKS_TTL and _jwks_cache["keys"]:
        return _jwks_cache["keys"]
    try:
        r = httpx.get(url, timeout=8.0)
        r.raise_for_status()
        keys = {k.get("kid"): k for k in r.json().get("keys", []) if isinstance(k, dict)}
    except Exception as exc:  # network, JSON or HTTP errors
        raise TokenError(f"could not load signing keys ({exc.__class__.__name__})")
    _jwks_cache.update(at=now, url=url, keys=keys)
    return keys


def verify_token(token: str) -> dict:
    """Return the verified claims of a Neon Auth JWT, or raise TokenError."""
    if not configured():
        raise TokenError("sign-in is not configured")
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise TokenError("malformed token")
    if header.get("alg") != "EdDSA":
        raise TokenError("unexpected signing algorithm")  # never accept 'none' or HMAC
    kid = header.get("kid")
    keys = _fetch_jwks()
    if kid not in keys:
        keys = _fetch_jwks(force=True)  # keys may have rotated
    jwk = keys.get(kid)
    if not jwk:
        raise TokenError("unknown signing key")
    try:
        key = jwt.PyJWK(jwk, algorithm="EdDSA").key
        origin = _origin(auth_base())
        claims = jwt.decode(token, key=key, algorithms=["EdDSA"], issuer=origin, audience=origin,
                            options={"require": ["exp", "iat", "sub"]}, leeway=30)
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc))
    if claims.get("banned"):
        raise TokenError("account disabled")
    return claims


def user_from_claims(claims: dict) -> dict:
    return {"id": str(claims["sub"]), "email": claims.get("email") or "", "name": claims.get("name") or "",
            "email_verified": bool(claims.get("emailVerified"))}


async def identity_middleware(request: Request, call_next):
    """Attach the verified user (if any) to this request. A present-but-invalid token is
    rejected with 401 rather than silently treated as a guest."""
    token = None
    authz = request.headers.get("authorization", "")
    if authz.lower().startswith("bearer ") and not request.url.path.startswith("/api/auth/"):
        token = authz[7:].strip()
    reset = None
    if token:
        try:
            claims = await run_in_threadpool(verify_token, token)  # key fetch must not block the loop
            reset = current_user.set(user_from_claims(claims))
        except TokenError:
            return JSONResponse(status_code=401, content={"detail": "Your sign-in has expired. Please sign in again."})
    try:
        return await call_next(request)
    finally:
        if reset is not None:
            current_user.reset(reset)


# ------------------------------------------------------------------ same-origin proxy
def rewrite_set_cookie(value: str) -> str:
    """Make a Neon Auth cookie a first-party cookie on our domain: drop any Domain
    attribute and use Path=/ (the proxy lives under /api/auth)."""
    parts = [p.strip() for p in value.split(";")]
    out = [parts[0]]
    for attr in parts[1:]:
        name = attr.split("=", 1)[0].strip().lower()
        if name in ("domain", "path"):
            continue
        out.append(attr)
    out.insert(1, "Path=/")
    return "; ".join(out)


async def proxy(request: Request, path: str) -> Response:
    base = auth_base()
    if not base:
        return JSONResponse(status_code=503, content={"detail": "Sign-in is not set up on this site yet."})
    if not SAFE_PATH.match(path) or ".." in path:
        return JSONResponse(status_code=404, content={"detail": "Not found."})
    headers = {k: v for k, v in request.headers.items() if k.lower() in FORWARD_REQUEST or k.lower().startswith("x-neon")}
    body = await request.body()
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
            r = await client.request(request.method, f"{base}/{path}", params=request.query_params,
                                     content=body or None, headers=headers)
    except httpx.HTTPError:
        return JSONResponse(status_code=502, content={"detail": "The sign-in service could not be reached. Please try again."})
    resp = Response(content=r.content, status_code=r.status_code)
    for k, v in r.headers.items():
        if k.lower() in FORWARD_RESPONSE:
            resp.headers[k] = v
    for cookie in r.headers.get_list("set-cookie"):
        resp.headers.append("set-cookie", rewrite_set_cookie(cookie))
    resp.headers["cache-control"] = "no-store"
    return resp
