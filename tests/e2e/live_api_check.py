"""Live API checks against the deployed site. Usage: python live_api.py https://host"""
import os
import sys
import time

import httpx

BASE = sys.argv[1].rstrip("/")
CA = os.path.expanduser("~/.ccr/ca-bundle.crt")
client = httpx.Client(timeout=60, verify=CA if os.path.exists(CA) else True, trust_env=True)

results = []


def check(name, ok, info=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{info}]" if info else ""))


def post(path, body):
    return client.post(BASE + path, json=body)


# 0. health
h = client.get(BASE + "/api/health").json()
check("health: database connected", h.get("database") == "connected", str(h))

# 1. project
r = post("/api/projects", {"title": "Live deployment check (test data)", "question": "Deployment test"})
check("create project -> 201", r.status_code == 201, str(r.status_code))
pid = r.json()["id"]
P = f"/api/projects/{pid}"

# 2. fake-reference tests: never Verified
fakes = {
    "fake DOI": {"mode": "doi", "doi": "10.1234/efro-made-up-2026-xyz"},
    "real DOI + made-up title": {"mode": "fields", "doi": "10.1038/nature14539",
                                 "title": "Quantum gardening for urban bees", "authors": "LeCun, Y.", "year": 2015},
    "made-up title + author": {"mode": "fields", "title": "Neural lattice cognition in deep-sea octopus swarms",
                               "authors": "Zarkovian, Q.", "year": 2019},
    "real title + made-up author": {"mode": "fields", "title": "Deep learning",
                                    "authors": "Fabricated, Zed", "year": 2015},
    "pasted made-up reference": {"mode": "text", "text": "Quillbright, T. (2021). Recursive empathy engines. "
                                 "Journal of Imaginary Machines, 4(2), 11-29."},
}
for name, body in fakes.items():
    r = post(P + "/check", body)
    lab = r.json().get("label") if r.status_code == 200 else None
    check(f"check {name} -> not Verified", r.status_code == 200 and lab != "verified", f"label={lab}")
    check(f"check {name} -> Not found", lab == "not_found", f"label={lab}; {r.json().get('reason', '')[:110]}")
    time.sleep(0.4)

# 3. approval of a fake is refused server-side
r = post(P + "/references", fakes["fake DOI"])
check("approve fake DOI -> 422, not added", r.status_code == 422, str(r.status_code))
r = post(P + "/references", fakes["made-up title + author"])
check("approve made-up title -> 422, not added", r.status_code == 422, str(r.status_code))

# 4. real reference
real = {"mode": "fields", "title": "Deep learning", "authors": "LeCun, Y.; Bengio, Y.; Hinton, G.",
        "year": 2015, "doi": "10.1038/nature14539"}
r = post(P + "/check", real)
check("check real LeCun 2015 -> Verified", r.json().get("label") == "verified", r.json().get("reason", "")[:110])

# 5. search shows results but saves nothing
r = client.get(BASE + P + "/search", params={"q": "deep learning LeCun Bengio Hinton"})
sj = r.json()
check("search returns results", r.status_code == 200 and len(sj.get("results", [])) > 0,
      f"{r.status_code}, {len(sj.get('results', []))} results, status={sj.get('status')}")
refs = client.get(BASE + P + "/references").json()
n_refs = len(refs) if isinstance(refs, list) else len(refs.get("references", []))
check("nothing added automatically (0 refs before approval)", n_refs == 0, f"refs={n_refs}")

# 6. one-click approval
r = post(P + "/references", real)
ref = r.json()
check("approve real -> 201 Verified", r.status_code == 201 and ref.get("label") == "verified",
      f"{r.status_code} {ref.get('label')}")
check("approved record has CSL for APA", bool(ref.get("csl")), "")
check("retraction check ran", ref.get("retraction", {}).get("status") in ("none_found", "corrected", "concern", "retracted"),
      str(ref.get("retraction", {}).get("status")))
rid = ref.get("id")
r = post(P + "/references", real)
check("approve duplicate -> 409", r.status_code == 409, str(r.status_code))

# 7. paste mode with a real reference
r = post(P + "/check", {"mode": "text", "text": "Hinton, G. E., & Salakhutdinov, R. R. (2006). Reducing the "
                        "dimensionality of data with neural networks. Science, 313(5786), 504-507."})
check("paste real Hinton 2006 -> Verified", r.json().get("label") == "verified", r.json().get("reason", "")[:110])

# 8. retraction flag
r = post(P + "/references", {"mode": "doi", "doi": "10.1016/s0140-6736(97)11096-0"})
rj = r.json()
check("Wakefield 1998 approved and flagged retracted",
      r.status_code == 201 and rj.get("retraction", {}).get("status") == "retracted",
      f"{r.status_code} {rj.get('retraction', {}).get('status') if isinstance(rj, dict) else rj}")
wid = rj.get("id") if isinstance(rj, dict) else None

# 9. list has labels
refs = client.get(BASE + P + "/references").json()
items = refs if isinstance(refs, list) else refs.get("references", [])
check("reference list: 2 items, every item labelled", len(items) == 2 and all(i.get("label") for i in items),
      f"{len(items)} items: {[i.get('label') for i in items]}")

# 10. export / statement events
for ev in ("EXPORT_APA_COPIED", "EXPORT_APA_DOWNLOADED", "STATEMENT_COPIED"):
    r = post(P + "/events", {"event": ev, "detail": {"count": 1}})
    check(f"record event {ev} -> 201", r.status_code == 201, str(r.status_code))
r = post(P + "/events", {"event": "REFERENCE_APPROVED", "detail": {}})
check("client cannot forge an approval event", r.status_code in (400, 422), str(r.status_code))

# 11. summary and audit
s = client.get(BASE + P + "/summary").json()
check("summary returns recorded counts", s and isinstance(s, dict), str(s)[:220])
a = client.get(BASE + P + "/audit").json()
evs = a if isinstance(a, list) else a.get("events", [])
appr = [e for e in evs if e.get("event") == "REFERENCE_APPROVED" or e.get("type") == "REFERENCE_APPROVED"]
check("audit log has 2 user approvals", len(appr) == 2 and all(e.get("actor") == "user" for e in appr),
      f"{len(evs)} events, {len(appr)} approvals")

# 12. remove a reference
if wid:
    r = client.delete(BASE + P + f"/references/{wid}")
    check("remove reference", r.status_code in (200, 204), str(r.status_code))

# 13. bad input
r = client.get(BASE + "/api/projects/not-a-valid-id")
check("invalid project id rejected", r.status_code in (404, 422), str(r.status_code))

passed = sum(ok for _, ok in results)
print(f"\n{passed}/{len(results)} live API checks passed. Project id: {pid}")
sys.exit(0 if passed == len(results) else 1)
