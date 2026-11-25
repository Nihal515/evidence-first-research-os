"""Local stand-in for Neon Auth (managed Better Auth) used only for testing on 127.0.0.1.
Implements the endpoints the SDK calls, issues EdDSA JWTs, enforces an Origin allowlist
like Better Auth's CSRF check, and logs every request so we can see what the SDK sends."""
import base64
import json
import secrets
import time

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

ORIGIN = "http://127.0.0.1:8100"
TRUSTED = {"http://127.0.0.1:4173", "http://localhost:4173"}
KEY = Ed25519PrivateKey.generate()
RAW = KEY.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
JWK = {"kty": "OKP", "crv": "Ed25519", "x": base64.urlsafe_b64encode(RAW).rstrip(b"=").decode(), "kid": "mock-1", "alg": "EdDSA"}
users, sessions = {}, {}
COOKIE = "neon-auth.session_token"
app = FastAPI()
LOG = open("mock_neon_auth_requests.log", "a")


def log(request: Request, note=""):
    LOG.write(json.dumps({"method": request.method, "path": request.url.path, "origin": request.headers.get("origin"),
                          "has_cookie": COOKIE in (request.headers.get("cookie") or ""),
                          "x-neon": {k: v for k, v in request.headers.items() if k.startswith("x-neon")}, "note": note}) + "\n")
    LOG.flush()


def csrf_ok(request: Request) -> bool:
    return request.headers.get("origin") in TRUSTED


def user_out(u):
    return {"id": u["id"], "email": u["email"], "name": u["name"], "emailVerified": False, "image": None,
            "createdAt": "2026-11-25T00:00:00.000Z", "updatedAt": "2026-11-25T00:00:00.000Z"}


def start_session(u):
    tok = secrets.token_urlsafe(24)
    sessions[tok] = u["id"]
    session = {"id": tok[:8], "token": tok, "userId": u["id"], "expiresAt": "2026-12-25T00:00:00.000Z"}
    resp = JSONResponse({"redirect": False, "token": tok, "user": user_out(u)})
    resp.set_cookie(COOKIE, tok, httponly=True, samesite="lax", path="/neondb/auth", domain="127.0.0.1", max_age=86400)
    return resp


@app.post("/neondb/auth/sign-up/email")
async def sign_up(request: Request):
    log(request)
    if not csrf_ok(request):
        return JSONResponse({"code": "INVALID_ORIGIN", "message": "Invalid origin"}, status_code=403)
    body = await request.json()
    email = body["email"].lower()
    if email in users:
        return JSONResponse({"code": "USER_ALREADY_EXISTS", "message": "User already exists"}, status_code=422)
    users[email] = {"id": "usr_" + secrets.token_hex(6), "email": email, "name": body.get("name") or "", "password": body["password"]}
    return start_session(users[email])


@app.post("/neondb/auth/sign-in/email")
async def sign_in(request: Request):
    log(request)
    if not csrf_ok(request):
        return JSONResponse({"code": "INVALID_ORIGIN", "message": "Invalid origin"}, status_code=403)
    body = await request.json()
    u = users.get(body.get("email", "").lower())
    if not u or u["password"] != body.get("password"):
        return JSONResponse({"code": "INVALID_EMAIL_OR_PASSWORD", "message": "Invalid email or password"}, status_code=401)
    return start_session(u)


@app.get("/neondb/auth/get-session")
async def get_session(request: Request):
    tok = request.cookies.get(COOKIE)
    log(request, "session" if tok in sessions else "no-session")
    if tok not in sessions:
        return JSONResponse(None)
    u = next(x for x in users.values() if x["id"] == sessions[tok])
    now = int(time.time())
    token = jwt.encode({**user_out(u), "role": "authenticated", "banned": False, "sub": u["id"], "iat": now, "exp": now + 900,
                        "iss": ORIGIN, "aud": ORIGIN}, KEY, algorithm="EdDSA", headers={"kid": "mock-1"})
    resp = JSONResponse({"session": {"id": tok[:8], "token": tok, "userId": u["id"], "expiresAt": "2026-12-25T00:00:00.000Z"},
                         "user": user_out(u)})
    resp.headers["set-auth-jwt"] = token
    return resp


@app.post("/neondb/auth/sign-out")
async def sign_out(request: Request):
    log(request)
    if not csrf_ok(request):
        return JSONResponse({"code": "INVALID_ORIGIN", "message": "Invalid origin"}, status_code=403)
    sessions.pop(request.cookies.get(COOKIE), None)
    resp = JSONResponse({"success": True})
    resp.delete_cookie(COOKIE, path="/neondb/auth", domain="127.0.0.1")
    return resp


@app.get("/neondb/auth/.well-known/jwks.json")
async def jwks(request: Request):
    log(request)
    return {"keys": [JWK]}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def other(path: str, request: Request):
    log(request, "UNHANDLED")
    return JSONResponse({"message": "not implemented in mock"}, status_code=404)
