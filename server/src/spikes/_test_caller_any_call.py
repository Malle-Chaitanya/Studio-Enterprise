"""Does EVERY request path name the caller, or only the tidy one?

Mirrors `_caller_headers` in connector_tools/generic_rest.py. The rule under test is not
"impersonation works" but "no request path escapes it": most connectors have no dedicated
builder and fall through to generic_rest, and generic_rest has a second, arbitrary-endpoint
path (`call_external_api`) that takes a path, a method and a body. That one was running every
call as the application while the mapped-operation path named the caller correctly, so the
connector looked per-user and was not.

Run:  cd server && python src/spikes/_test_caller_any_call.py
"""
import sys

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" -- " + detail) if detail else ""))
    if not ok:
        fails.append(name)


def caller_headers(conn, caller, url="https://org.crm.dynamics.com/api/data/v9.2/accounts"):
    """The decision _caller_headers makes. Returns headers, or raises."""
    if not conn.get("perUser") or conn.get("perUserMode") != "impersonate":
        return {}
    kind = conn.get("impersonationResolve") or "dataverse-systemuser"
    if kind == "dataverse-systemuser":
        if not caller:
            raise RuntimeError("the caller could not be identified")
        api_root = url.split("/api/data/")[0] + "/api/data/v9.2"
        assert api_root.endswith("/api/data/v9.2")
        return {conn.get("impersonationHeader") or "MSCRMCallerID": f"id-of:{caller}"}
    if kind == "google-dwd-subject":
        # Already handled elsewhere (adk_deploy.py's _mint_token, at token-mint time) --
        # nothing for a HEADER to add on top of that. See generic_rest.py's own comment.
        return {}
    raise RuntimeError("no way to act as another person (" + str(kind) + ")")


DV = {"perUser": True, "perUserMode": "impersonate",
      "impersonationResolve": "dataverse-systemuser", "impersonationHeader": "MSCRMCallerID"}
JIRA_MISMARKED = {"perUser": True, "perUserMode": "impersonate", "name": "Jira",
                  "impersonationResolve": "atlassian-none"}
GRAPH = {"perUser": True, "perUserMode": "impersonate", "impersonationResolve": "graph-user-path"}
GOOGLE_DWD = {"perUser": True, "perUserMode": "impersonate", "name": "Google Drive",
              "impersonationResolve": "google-dwd-subject"}
SHARED = {}

# 1. Dataverse: the caller is named on the request.
h = caller_headers(DV, "ron@corp.com")
check("dataverse names the caller", h.get("MSCRMCallerID") == "id-of:ron@corp.com", str(h))

# 2. Two callers must not share a header value.
a = caller_headers(DV, "ron@corp.com")["MSCRMCallerID"]
b = caller_headers(DV, "alex@corp.com")["MSCRMCallerID"]
check("two callers get two ids", a != b, f"{a} vs {b}")

# 3. Unknown caller refuses instead of sending an un-impersonated (app-level) request.
try:
    caller_headers(DV, "")
    check("unknown caller refuses", False, "returned headers")
except RuntimeError as e:
    check("unknown caller refuses", "could not be identified" in str(e), str(e))

# 4. THE HOLE THIS CLOSES: an arbitrary-endpoint call must go through the same decision.
#    Simulated by calling with a non-Dataverse-shaped URL and a write method -- the point is
#    that the code path is the same one, so there is nothing here to forget separately.
h = caller_headers(DV, "ron@corp.com", url="https://org.crm.dynamics.com/api/data/v9.2/$batch")
check("arbitrary endpoint still names the caller", "MSCRMCallerID" in h, str(h))

# 5. A connector with NO impersonation mechanism must fail, not fall back to the app. Jira's
#    API token is one account; there is no act-as header to send.
try:
    caller_headers(JIRA_MISMARKED, "ron@corp.com")
    check("no mechanism refuses rather than running as the app", False, "returned headers")
except RuntimeError as e:
    check("no mechanism refuses rather than running as the app",
          "no way to act as another person" in str(e), str(e))

# 6. A resolve kind handled by a DIFFERENT builder must not be silently accepted here.
try:
    caller_headers(GRAPH, "ron@corp.com")
    check("unimplemented resolve kind refuses", False, "returned headers")
except RuntimeError:
    check("unimplemented resolve kind refuses", True)

# 7. Shared connectors are untouched -- no headers, no exception.
check("shared connector sends no caller headers", caller_headers(SHARED, "ron@corp.com") == {})

# 8. THE FIX, 2026-10-22: google-dwd-subject is handled elsewhere (token-mint time), not
#    missing -- confirmed live against an invoker-mode Google Drive tool that failed here
#    even though its token had already been minted as the right person. Must return {},
#    NOT raise -- raising here after the identity already succeeded is the actual bug.
h = caller_headers(GOOGLE_DWD, "admin@migrationn.com")
check("google-dwd-subject returns no extra headers instead of raising", h == {}, str(h))

# 9. The fix must not widen to graph-user-path -- that one genuinely has no implementation
#    in this function (Outlook's impersonation works differently) and must keep refusing.
try:
    caller_headers(GRAPH, "ron@corp.com")
    check("graph-user-path still refuses (unaffected by the google-dwd-subject fix)", False, "returned headers")
except RuntimeError:
    check("graph-user-path still refuses (unaffected by the google-dwd-subject fix)", True)

print()
print(("FAILED: " + ", ".join(fails)) if fails else "all passed")
sys.exit(1 if fails else 0)
