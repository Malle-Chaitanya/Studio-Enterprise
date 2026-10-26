"""Proves `_supersede_dedicated_tools` (adk_deploy.py) in both of its modes:

  - FULL_CATALOG_REPLACEMENT = False (the no-regression default): nothing approved yet ->
    byte-identical to the dedicated tools; something approved -> catalog tools are ADDED
    alongside the dedicated ones, nothing removed.
  - FULL_CATALOG_REPLACEMENT = True (the explicit, requested exception for a live test):
    nothing approved yet -> still byte-identical (there is nothing to replace); something
    approved -> dedicated tools with a catalog replacement are dropped, catalog tools take
    their place, but dedicated tools in FULL_REPLACEMENT_KEEP_LIST (real capabilities the
    catalog has no way to express — create/update-with-content, find-by-path, archive
    extraction) survive regardless.

Run directly:
    cd server && python scripts/_test_catalog_supersession.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import adk_deploy  # noqa: E402
from adk_deploy import _supersede_dedicated_tools  # noqa: E402

failures = []


def check(label, condition):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        failures.append(label)


def fake_tool(name):
    def _fn(*a, **kw):
        return {}
    _fn.__name__ = name
    return _fn


drive_tools = [fake_tool(n) for n in (
    "google_drive_list_files", "google_drive_read_file", "google_drive_get_metadata",
    "google_drive_copy_file", "google_drive_delete_file",
    # create_file_by_path now HAS a catalog equivalent too (the generic "createIfMissing"
    # chain capability, added 2026-10-26) -- it moved out of the survives-forever group.
    "google_drive_create_file_by_path",
    # Has a catalog replacement for NOTHING, and never will -- confirmed no Drive API
    # endpoint exists for archive extraction at all. Must survive full replacement either way.
    "google_drive_extract_archive",
)]

NOOP_SECRET = lambda name: "x"  # noqa: E731
NOOP_MINT = lambda fill: "tok"  # noqa: E731
NOOP_AUTH = lambda fill: "Bearer tok"  # noqa: E731
NOOP_FILL = lambda tpl: tpl  # noqa: E731

base_conn = {"kind": "googledrive", "name": "Google Drive", "authKind": "google-service-account"}
approved_op = {
    "operationId": "GetFileMetadata",
    "toolName": "get_file_metadata_using_id",
    "method": "GET",
    "urlTemplate": "https://www.googleapis.com/drive/v3/files/{fileId}",
    "parameters": [{"name": "fileId", "in": "path", "required": True, "type": "string"}],
    "auth": "google-oauth",
}

# ── Common to both modes: nothing approved yet -> unchanged ────────────────────────────
check(
    "no boundOperations at all -> unchanged, same function objects",
    _supersede_dedicated_tools(drive_tools, {**base_conn}, NOOP_SECRET, NOOP_MINT, NOOP_AUTH, NOOP_FILL) is drive_tools,
)
check(
    "empty boundOperations list -> unchanged",
    _supersede_dedicated_tools(drive_tools, {**base_conn, "boundOperations": []}, NOOP_SECRET, NOOP_MINT, NOOP_AUTH, NOOP_FILL) is drive_tools,
)

# ── Mode: additive (FULL_CATALOG_REPLACEMENT = False) ──────────────────────────────────
adk_deploy.FULL_CATALOG_REPLACEMENT = False
result_add = _supersede_dedicated_tools(
    drive_tools, {**base_conn, "boundOperations": [approved_op]}, NOOP_SECRET, NOOP_MINT, NOOP_AUTH, NOOP_FILL,
)
names_add = {getattr(fn, "__name__", "?") for fn in result_add}
check("additive mode: all 7 dedicated tools kept", {fn.__name__ for fn in drive_tools} <= names_add)
check("additive mode: catalog tool added too", "get_file_metadata_using_id" in names_add)
check("additive mode: total is dedicated + catalog, nothing dropped", len(result_add) == 8)

# ── Mode: full replacement (FULL_CATALOG_REPLACEMENT = True) ───────────────────────────
adk_deploy.FULL_CATALOG_REPLACEMENT = True
result_full = _supersede_dedicated_tools(
    drive_tools, {**base_conn, "boundOperations": [approved_op]}, NOOP_SECRET, NOOP_MINT, NOOP_AUTH, NOOP_FILL,
)
names_full = {getattr(fn, "__name__", "?") for fn in result_full}
REPLACED = {"google_drive_list_files", "google_drive_read_file", "google_drive_get_metadata",
            "google_drive_copy_file", "google_drive_delete_file", "google_drive_create_file_by_path"}
KEPT_NO_EQUIVALENT = {"google_drive_extract_archive"}
check("full-replacement mode: tools WITH a catalog equivalent are dropped", not (REPLACED & names_full))
check("full-replacement mode: tools with NO catalog equivalent survive", KEPT_NO_EQUIVALENT <= names_full)
check("full-replacement mode: the catalog tool is present", "get_file_metadata_using_id" in names_full)
check("full-replacement mode: total is kept(1) + catalog(1)", len(result_full) == 2)

# ── Gmail/Calendar/Contacts keep-lists, added 2026-10-22, shrunk the same day once real
#    catalog/always-on equivalents existed for what they used to protect ──────────────────
adk_deploy.FULL_CATALOG_REPLACEMENT = True
gmail_tools = [fake_tool(n) for n in ("gmail_read_message", "gmail_list_labels", "gmail_get_attachment")]
gmail_conn = {"kind": "gmail", "name": "Gmail", "authKind": "google-service-account",
              "boundOperations": [{**approved_op, "toolName": "get_email_details"}]}
gmail_result = _supersede_dedicated_tools(gmail_tools, gmail_conn, NOOP_SECRET, NOOP_MINT, NOOP_AUTH, NOOP_FILL)
gmail_names = {getattr(fn, "__name__", "?") for fn in gmail_result}
check("gmail keep-list is now empty: ALL of labels/attachments/read now have catalog equivalents, so none survive",
      not ({"gmail_read_message", "gmail_list_labels", "gmail_get_attachment"} & gmail_names))

calendar_tools = [fake_tool(n) for n in ("calendar_create_event", "calendar_check_availability", "calendar_get_current_datetime")]
calendar_conn = {"kind": "googlecalendar", "name": "Google Calendar", "authKind": "google-service-account",
                 "boundOperations": [{**approved_op, "toolName": "create_event"}]}
calendar_result = _supersede_dedicated_tools(calendar_tools, calendar_conn, NOOP_SECRET, NOOP_MINT, NOOP_AUTH, NOOP_FILL)
calendar_names = {getattr(fn, "__name__", "?") for fn in calendar_result}
check("calendar keep-list: check-availability now HAS a catalog equivalent, so it is dropped",
      "calendar_check_availability" not in calendar_names)
check("calendar keep-list is now empty: get_current_datetime now HAS a localCompute catalog "
      "equivalent too, so it is dropped",
      "calendar_get_current_datetime" not in calendar_names)

contacts_tools = [fake_tool(n) for n in ("contacts_list_contacts", "contacts_update_contact")]
contacts_conn = {"kind": "googlecontacts", "name": "Google Contacts", "authKind": "google-service-account",
                 "boundOperations": [{**approved_op, "toolName": "get_my_contacts"}]}
contacts_result = _supersede_dedicated_tools(contacts_tools, contacts_conn, NOOP_SECRET, NOOP_MINT, NOOP_AUTH, NOOP_FILL)
check("contacts keep-list is now empty: update-contact now HAS a catalog equivalent, so it is dropped",
      "contacts_update_contact" not in {getattr(fn, "__name__", "?") for fn in contacts_result})

adk_deploy.FULL_CATALOG_REPLACEMENT = False  # restore, in case anything else imports this module in-process

print(f"\n{len(failures)} failure(s) out of a full run." if failures else "\nAll checks passed.")
sys.exit(1 if failures else 0)
