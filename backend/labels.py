"""Trust labels shown on every reference and claim.

The website uses exactly four labels. Each is defined once here and the same
wording is shown on screen in the trust-label key.
"""

VERIFIED = "verified"
NOT_YET_VERIFIED = "not_yet_verified"
AI_SUGGESTION = "ai_suggestion"
NOT_FOUND = "not_found"

LABELS = {
    VERIFIED: {
        "text": "Verified",
        "meaning": "Matched live against a scholarly database (Crossref, doi.org or OpenAlex), "
        "or backed by a located passage.",
    },
    NOT_YET_VERIFIED: {
        "text": "Not yet verified",
        "meaning": "Not checked yet, or the live check could not run. Never treated as verified.",
    },
    AI_SUGGESTION: {
        "text": "AI suggestion",
        "meaning": "Written by AI, with no source checked behind it.",
    },
    NOT_FOUND: {
        "text": "Not found",
        "meaning": "No matching record in the databases that were checked. It may not exist.",
    },
}
