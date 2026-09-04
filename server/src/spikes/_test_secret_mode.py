"""Which credential does a per-user tool read? The three modes must stay distinct.

Mirrors the branch in adk_deploy.py `_secret`. Duplicated deliberately: that function is a
closure inside `_build_live_connector_tool` that cannot be imported without a live project
and token, and leaving the rule untested because of where it lives is how it regressed --
impersonating connectors have NO per-user secrets by design, and reading their empty
`perUserFields` as "no per-user sign-in" made every call fail closed for everybody. A live
two-caller test caught it; this catches it in a second.

Run:  cd server && python src/spikes/_test_secret_mode.py
"""
import sys

fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + ((" -- " + detail) if detail else ""))
    if not ok:
        fails.append(name)


def resolve(conn, field, secret_id, caller):
    """Returns the secret id to read, or raises -- the same decision _secret makes."""
    per_user = bool(conn.get("perUser"))
    per_user_fields = set(conn.get("perUserFields") or [])
    impersonating = per_user and conn.get("perUserMode") == "impersonate"

    if per_user and not impersonating and field in per_user_fields:
        if not caller:
            raise RuntimeError("caller could not be identified")
        return f"{secret_id}-u-{caller.lower()}"
    if per_user and not impersonating and not per_user_fields:
        raise RuntimeError("no per-user sign-in")
    return secret_id


IMPERSONATE = {"perUser": True, "perUserMode": "impersonate", "perUserFields": []}
DELEGATED = {"perUser": True, "perUserMode": "delegated", "perUserFields": ["refresh_token"]}
BLOCKED = {"perUser": True, "perUserFields": []}
SHARED = {}

# 1. Impersonation uses the SHARED credential. The caller is named on the request instead.
try:
    got = resolve(IMPERSONATE, "client_secret", "sec-abc", "ben@x.com")
    check("impersonate reads the shared secret", got == "sec-abc", got)
except Exception as e:  # noqa: BLE001
    check("impersonate reads the shared secret", False, f"{type(e).__name__}: {e}")

# 2. THE REGRESSION: empty perUserFields must not read as "no per-user sign-in" here.
try:
    resolve(IMPERSONATE, "client_id", "sec-abc", "ben@x.com")
    check("impersonate does not fail closed on empty perUserFields", True)
except Exception as e:  # noqa: BLE001
    check("impersonate does not fail closed on empty perUserFields", False, str(e))

# 3. Impersonation works even when the caller is unknown at THIS layer -- the connector
#    module refuses instead, with a message naming the tool.
try:
    resolve(IMPERSONATE, "client_secret", "sec-abc", "")
    check("impersonate does not need a caller to read the app credential", True)
except Exception as e:  # noqa: BLE001
    check("impersonate does not need a caller to read the app credential", False, str(e))

# 4. Delegated: the personal field is keyed by caller, the app fields are not.
try:
    a = resolve(DELEGATED, "refresh_token", "sec-abc", "Ben@X.com")
    b = resolve(DELEGATED, "client_secret", "sec-abc", "Ben@X.com")
    check("delegated keys only the personal field", a == "sec-abc-u-ben@x.com" and b == "sec-abc", f"{a} / {b}")
except Exception as e:  # noqa: BLE001
    check("delegated keys only the personal field", False, str(e))

# 5. Delegated with an unknown caller must refuse, never fall back to the shared token.
try:
    resolve(DELEGATED, "refresh_token", "sec-abc", "")
    check("delegated refuses an unknown caller", False, "did not raise")
except RuntimeError:
    check("delegated refuses an unknown caller", True)

# 6. per-user with no mechanism at all still fails closed for everyone.
try:
    resolve(BLOCKED, "api_key", "sec-abc", "ben@x.com")
    check("no mechanism fails closed", False, "did not raise")
except RuntimeError:
    check("no mechanism fails closed", True)

# 7. A shared (maker) connector is untouched by any of this.
try:
    got = resolve(SHARED, "api_key", "sec-abc", "")
    check("shared connector unchanged", got == "sec-abc", got)
except Exception as e:  # noqa: BLE001
    check("shared connector unchanged", False, str(e))

print()
print("FAILURES: " + (", ".join(fails) if fails else "none"))
sys.exit(1 if fails else 0)
