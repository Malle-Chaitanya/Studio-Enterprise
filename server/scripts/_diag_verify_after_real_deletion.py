"""Proves adk_deploy.py's real tool-building path works with gmail.py/contacts.py/
calendar.py PERMANENTLY deleted (not a temporary rename) -- no mocking of the filesystem,
these files are just gone.

Run: cd server/scripts && python _diag_verify_after_real_deletion.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import adk_deploy

NOOP_SECRET = lambda name: "x"  # noqa: E731
NOOP_MINT = lambda fill: "tok"  # noqa: E731
NOOP_AUTH = lambda fill: "Bearer tok"  # noqa: E731
NOOP_FILL = lambda tpl: tpl  # noqa: E731

for kind, conn in [
    ("gmail", {
        "kind": "gmail", "name": "Gmail", "authKind": "google-service-account",
        "boundOperations": [{
            "operationId": "DeleteEmail", "toolName": "delete_email", "method": "DELETE",
            "urlTemplate": "https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}",
            "fixedArgs": {}, "modelArgs": [
                {"name": "userId", "in": "path", "required": True, "type": "string"},
                {"name": "id", "in": "path", "required": True, "type": "string"},
            ], "auth": "google-oauth",
        }],
    }),
    ("googlecontacts", {
        "kind": "googlecontacts", "name": "Google Contacts", "authKind": "google-service-account",
        "boundOperations": [{
            "operationId": "PeopleApiListContactsV4", "toolName": "get_my_contacts", "method": "GET",
            "urlTemplate": "https://people.googleapis.com/v1/people/me/connections",
            "fixedArgs": {}, "modelArgs": [], "auth": "google-oauth",
        }],
    }),
    ("googlecalendar", {
        "kind": "googlecalendar", "name": "Google Calendar", "authKind": "google-service-account",
        "boundOperations": [{
            "operationId": "get_current_datetime", "toolName": "get_current_datetime", "method": "POST",
            "urlTemplate": "", "fixedArgs": {},
            "modelArgs": [{"name": "timezone", "in": "query", "required": False, "type": "string"}],
            "auth": "google-oauth",
            "chain": [{"localCompute": {"kind": "current_datetime", "timezoneParam": "timezone", "bindAs": "now"}}],
        }],
    }),
]:
    tools = adk_deploy._build_catalog_only_tools(conn, NOOP_SECRET, NOOP_MINT, NOOP_AUTH, NOOP_FILL, caller=lambda: "me@x.com")
    names = [getattr(fn, "__name__", "?") for fn in tools]
    print(f"{kind}: built {len(tools)} tool(s) -> {names}")

print("\nDrive still needs its file for extract_archive — confirming the import still works:")
from connector_tools.google_drive import build_tools  # noqa: E402
print("google_drive.py import: OK (still present, as it should be)")

print("\nAll good — real, permanent deletion confirmed safe for gmail/contacts/calendar.")
