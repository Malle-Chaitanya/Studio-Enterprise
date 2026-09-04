"""Whose Google account does a minted token act as? The DWD subject decides everything.

Mirrors the branch added to adk_deploy.py `_mint_token`. Duplicated for the same reason as
_test_secret_mode.py: `_mint_token` is a closure inside `_build_live_connector_tool` and
cannot be imported without a live project, a service-account key and a real token exchange.

Why this rule is worth a test of its own: for Google connectors the subject is applied ONCE,
at mint time, and every tool built on that token inherits it silently -- Drive create/update/
delete, and Gmail SEND. A wrong subject here does not fail; it succeeds as the wrong person.

Run:  cd server && python src/spikes/_test_dwd_subject.py
"""
import sys

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" -- " + detail) if detail else ""))
    if not ok:
        fails.append(name)


def subject_for(conn, caller, pinned="agent-owner@corp.com"):
    """Returns the DWD subject to mint as, or raises -- the decision _mint_token makes."""
    impersonating = bool(conn.get("perUser")) and conn.get("perUserMode") == "impersonate"
    if impersonating and conn.get("impersonationResolve") == "google-dwd-subject":
        if not caller:
            raise RuntimeError("the caller could not be identified")
        return caller
    return pinned or None


PER_USER = {"perUser": True, "perUserMode": "impersonate",
            "impersonationResolve": "google-dwd-subject"}
GRAPH = {"perUser": True, "perUserMode": "impersonate",
         "impersonationResolve": "graph-user-path"}
SHARED = {}

# 1. The whole point: an invoker Google connector acts as whoever asked.
got = subject_for(PER_USER, "alex@corp.com")
check("per-user mints as the caller", got == "alex@corp.com", got)

# 2. Two callers must not collapse onto one subject. This is the failure that looks like
#    success -- both get an answer, both get the SAME person's Drive.
a = subject_for(PER_USER, "alex@corp.com")
b = subject_for(PER_USER, "ron@corp.com")
check("two callers get two subjects", a != b, f"{a} vs {b}")

# 3. Unknown caller must FAIL, not fall back to the pinned account. Falling back would send
#    Gmail as one fixed person on behalf of someone else.
try:
    subject_for(PER_USER, "")
    check("unknown caller fails closed", False, "returned a subject instead of raising")
except RuntimeError as e:
    check("unknown caller fails closed", "could not be identified" in str(e), str(e))

# 4. The caller is used VERBATIM. No identity map, no local-part guessing: an ADK user_id is
#    already a Google address. (Outlook is the opposite case and maps first.)
got = subject_for(PER_USER, "Ron.Smith@corp.com")
check("caller used verbatim, not normalised or guessed", got == "Ron.Smith@corp.com", got)

# 5. A maker/shared connector is untouched -- still the per-agent pinned identity.
got = subject_for(SHARED, "alex@corp.com")
check("shared connector still uses the pinned subject", got == "agent-owner@corp.com", got)

# 6. Impersonation by a DIFFERENT mechanism must not be hijacked here. Outlook impersonates
#    via /users/{caller} on the request, and its token stays app-level.
got = subject_for(GRAPH, "alex@corp.com")
check("graph-user-path connector keeps the pinned subject", got == "agent-owner@corp.com", got)

# 7. A per-user connector with no pinned account still refuses rather than minting an
#    unsubjected (service-account-level) token, which would read the WHOLE domain.
try:
    subject_for(PER_USER, "", pinned="")
    check("no caller and no pinned account still refuses", False, "returned instead of raising")
except RuntimeError:
    check("no caller and no pinned account still refuses", True)

print()
print(("FAILED: " + ", ".join(fails)) if fails else "all passed")
sys.exit(1 if fails else 0)
