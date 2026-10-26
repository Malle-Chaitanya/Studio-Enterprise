"""Proves the generic "chain" executor (generic_rest.py's `_invoke_chain`) against the real
operations it was built for: resolving a Drive file by PATH (a repeating step, one HTTP call
per path segment), creating a file WITH CONTENT (two plain sequential steps, the second
carrying a real request body), and replying to a Gmail message (extracting several header
values from one response, then assembling + base64-encoding a real RFC 2822 reply). Mocks
urllib.request.urlopen entirely -- no network.

Run:
    cd server && python scripts/_test_chain_operations.py
"""
import json as _json
import sys
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from connector_tools import generic_rest  # noqa: E402

failures = []


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}" + (f" -- {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


NOOP_SECRET = lambda name: "x"  # noqa: E731
NOOP_MINT = lambda fill: "tok"  # noqa: E731
NOOP_AUTH = lambda fill: "Bearer tok"  # noqa: E731
NOOP_FILL = lambda tpl: tpl  # noqa: E731


class _FakeResp:
    def __init__(self, body: dict):
        self._raw = _json.dumps(body).encode("utf-8")

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _route_by_url(routes):
    """Returns a fake urlopen(request, timeout=...) that answers by matching the request's
    URL against `routes` (list of (substring, response_dict_or_Exception) tried in order)."""
    def _fake_urlopen(req, timeout=None):  # noqa: ARG001
        url = req.full_url
        for substr, outcome in routes:
            if substr in url:
                if isinstance(outcome, Exception):
                    raise outcome
                return _FakeResp(outcome)
        raise AssertionError(f"no route matched URL: {url}")
    return _fake_urlopen


def _build(conn, caller=None):
    return generic_rest.build_tools(conn, NOOP_SECRET, NOOP_MINT, NOOP_AUTH, NOOP_FILL, caller=caller)


# ── 1. Resolve-by-path: "Reports/2026/file.csv" -> three segment lookups, then a final
#      metadata fetch using the last resolved id. Real success case. ──────────────────────
GET_BY_PATH_OP = {
    "operationId": "GetFileMetadataByPath",
    "toolName": "get_file_metadata_by_path",
    "method": "GET",
    "urlTemplate": "",
    "modelArgs": [{"name": "path", "in": "query", "required": True, "type": "string"}],
    "auth": "google-oauth",
    "chain": [
        {
            "method": "GET",
            "urlTemplate": "https://www.googleapis.com/drive/v3/files?q=name=%27{segment}%27+and+%27{parentId}%27+in+parents",
            "extractPath": "files",
            "itemIdField": "id",
            "bindAs": "parentId",
            "initialValue": "root",
            "itemNoun": "item",
            "repeatOverParam": "path",
        },
        {
            "method": "GET",
            "urlTemplate": "https://www.googleapis.com/drive/v3/files/{parentId}?fields=id,name,mimeType",
        },
    ],
}
conn1 = {"kind": "googledrive", "name": "Google Drive", "authKind": "google-service-account",
         "boundOperations": [GET_BY_PATH_OP]}

with patch.object(urllib.request, "urlopen", side_effect=_route_by_url([
    ("q=name=%27Reports%27", {"files": [{"id": "id-reports"}]}),
    ("q=name=%272026%27", {"files": [{"id": "id-2026"}]}),
    ("q=name=%27file.csv%27", {"files": [{"id": "id-file-csv"}]}),
    ("/files/id-file-csv", {"id": "id-file-csv", "name": "file.csv", "mimeType": "text/csv"}),
])):
    tools = _build(conn1)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(path="Reports/2026/file.csv")
check(
    "resolve-by-path: 3 segments resolved, final metadata returned",
    result.get("body", {}).get("name") == "file.csv",
    str(result),
)

# ── 2. Resolve-by-path: a segment matches NOTHING -> clear "not found", not a crash ───────
with patch.object(urllib.request, "urlopen", side_effect=_route_by_url([
    ("q=name=%27Reports%27", {"files": []}),
])):
    tools = _build(conn1)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(path="Reports/2026/file.csv")
check(
    "resolve-by-path: not-found segment reports a clear error, not a crash",
    "error" in result and "not found" in result["error"] and "Reports" in result["error"],
    str(result),
)

# ── 3. Resolve-by-path: a segment matches MORE THAN ONE -> refuses, never guesses ─────────
with patch.object(urllib.request, "urlopen", side_effect=_route_by_url([
    ("q=name=%27Reports%27", {"files": [{"id": "a"}, {"id": "b"}]}),
])):
    tools = _build(conn1)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(path="Reports/2026/file.csv")
check(
    "resolve-by-path: ambiguous segment refuses rather than picking one",
    "error" in result and "ambiguous" in result["error"],
    str(result),
)

# ── 4. Create file WITH CONTENT: two plain steps, the second carrying a real body ─────────
CREATE_WITH_CONTENT_OP = {
    "operationId": "CreateFileV2",
    "toolName": "create_file_v2",
    "method": "POST",
    "urlTemplate": "",
    "modelArgs": [
        {"name": "name", "in": "query", "required": True, "type": "string"},
        {"name": "folderId", "in": "query", "required": True, "type": "string"},
        {"name": "content", "in": "query", "required": True, "type": "string"},
        {"name": "mimeType", "in": "query", "required": False, "type": "string"},
    ],
    "auth": "google-oauth",
    "chain": [
        {
            "method": "POST",
            "urlTemplate": "https://www.googleapis.com/drive/v3/files",
            "bodyTemplate": {"name": "{name}", "parents": ["{folderId}"], "mimeType": "{mimeType}"},
            "extractPath": "id",
            "bindAs": "fileId",
        },
        {
            "method": "PATCH",
            "urlTemplate": "https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=media",
            "bodyFromParam": "content",
            "bodyContentTypeParam": "mimeType",
        },
    ],
}
conn2 = {"kind": "googledrive", "name": "Google Drive", "authKind": "google-service-account",
         "boundOperations": [CREATE_WITH_CONTENT_OP]}

captured_requests = []


def _capturing_urlopen(req, timeout=None):  # noqa: ARG001
    captured_requests.append(req)
    if "/files" == req.full_url.split("?")[0].replace("https://www.googleapis.com/drive/v3", ""):
        return _FakeResp({"id": "new-file-id", "name": "notes.txt"})
    return _FakeResp({"id": "new-file-id"})


with patch.object(urllib.request, "urlopen", side_effect=_capturing_urlopen):
    tools = _build(conn2)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(name="notes.txt", folderId="root", content="hello world", mimeType="text/plain")

check("create-with-content: two requests were actually made", len(captured_requests) == 2, str(len(captured_requests)))
if len(captured_requests) == 2:
    step1, step2 = captured_requests
    check("create-with-content: step 1 posts JSON metadata", step1.get_header("Content-type") == "application/json", str(step1.headers))
    check(
        "create-with-content: step 1 body has the right name/parents/mimeType",
        _json.loads(step1.data.decode()) == {"name": "notes.txt", "parents": ["root"], "mimeType": "text/plain"},
        step1.data,
    )
    check("create-with-content: step 2 hits the NEW file's id", "new-file-id" in step2.full_url, step2.full_url)
    check("create-with-content: step 2 sends the RAW content, not JSON-wrapped", step2.data == b"hello world", step2.data)
    check("create-with-content: step 2 Content-Type matches the declared mimeType", step2.get_header("Content-type") == "text/plain", str(step2.headers))

# ── 5. Gmail reply: extract threadId + Message-ID/Subject headers from the original, then
#      send a correctly-threaded, base64url-encoded reply. ────────────────────────────────
import base64 as _base64  # noqa: E402

REPLY_OP = {
    "operationId": "ReplyToV2",
    "toolName": "reply_to_email",
    "method": "POST",
    "urlTemplate": "",
    "modelArgs": [
        {"name": "messageId", "in": "query", "required": True, "type": "string"},
        {"name": "body", "in": "query", "required": True, "type": "string"},
    ],
    "auth": "google-oauth",
    "chain": [
        {
            "method": "GET",
            "urlTemplate": "https://gmail.googleapis.com/gmail/v1/users/me/messages/{messageId}?format=metadata",
            "extracts": [
                {"path": "threadId", "bindAs": "threadId"},
                {"path": "payload.headers", "headerName": "Message-ID", "bindAs": "origMessageId"},
                {"path": "payload.headers", "headerName": "Subject", "bindAs": "origSubject"},
                {"path": "payload.headers", "headerName": "From", "bindAs": "origFrom"},
            ],
        },
        {
            "method": "POST",
            "urlTemplate": "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            "bodyTemplate": {"threadId": "{threadId}"},
            "mimeMessage": {
                "to": "{origFrom}",
                "subject": "Re: {origSubject}",
                "inReplyTo": "{origMessageId}",
                "references": "{origMessageId}",
                "body": "{body}",
            },
        },
    ],
}
conn3 = {"kind": "gmail", "name": "Gmail", "authKind": "google-service-account", "boundOperations": [REPLY_OP]}

reply_requests = []


def _reply_urlopen(req, timeout=None):  # noqa: ARG001
    reply_requests.append(req)
    if "/messages/orig-msg-1" in req.full_url:
        return _FakeResp({
            "id": "orig-msg-1",
            "threadId": "thread-abc",
            "payload": {"headers": [
                {"name": "Message-ID", "value": "<orig-rfc822-id@mail.example.com>"},
                {"name": "Subject", "value": "Original subject"},
                {"name": "From", "value": "sender@example.com"},
            ]},
        })
    return _FakeResp({"id": "sent-msg-1", "threadId": "thread-abc"})


with patch.object(urllib.request, "urlopen", side_effect=_reply_urlopen):
    tools = _build(conn3)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(messageId="orig-msg-1", body="Thanks, confirmed.")

check("gmail reply: two requests were made (read original, then send)", len(reply_requests) == 2, str(len(reply_requests)))
if len(reply_requests) == 2:
    get_req, send_req = reply_requests
    check("gmail reply: step 1 reads the ORIGINAL message", "orig-msg-1" in get_req.full_url, get_req.full_url)
    send_body = _json.loads(send_req.data.decode())
    check("gmail reply: send carries the ORIGINAL thread id", send_body.get("threadId") == "thread-abc", send_body)
    decoded_mime = _base64.urlsafe_b64decode(send_body["raw"]).decode("utf-8")
    check("gmail reply: MIME has the real In-Reply-To (not a placeholder)", "<orig-rfc822-id@mail.example.com>" in decoded_mime, decoded_mime)
    check("gmail reply: MIME threads the References header too", "References: <orig-rfc822-id@mail.example.com>" in decoded_mime, decoded_mime)
    check("gmail reply: MIME subject is prefixed Re: onto the ORIGINAL subject", "Subject: Re: Original subject" in decoded_mime, decoded_mime)
    check("gmail reply: MIME goes TO the original sender", "To: sender@example.com" in decoded_mime, decoded_mime)
    check("gmail reply: the model's own reply text made it into the body", "Thanks, confirmed." in decoded_mime, decoded_mime)
check("gmail reply: no top-level error", "error" not in result, str(result))

# ── 6. Calendar RSVP: fetch the event, update ONLY my own attendee entry, send the WHOLE
#      attendee list back (never just mine -- that would erase everyone else invited). ────
RSVP_OP = {
    "operationId": "RespondToEvent",
    "toolName": "respond_to_event",
    "method": "PATCH",
    "urlTemplate": "",
    "modelArgs": [
        {"name": "calendarId", "in": "query", "required": True, "type": "string"},
        {"name": "eventId", "in": "query", "required": True, "type": "string"},
        {"name": "status", "in": "query", "required": True, "type": "string"},  # "accepted"/"declined"/"tentative"
    ],
    "auth": "google-oauth",
    "chain": [
        {
            "method": "GET",
            "urlTemplate": "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}",
            "extracts": [{"path": "attendees", "bindAs": "attendees"}],
        },
        {
            "updateListEntry": {
                "listVar": "attendees",
                "matchField": "email",
                "matchValue": "{callerEmail}",
                "setField": "responseStatus",
                "setValue": "{status}",
                "bindAs": "updatedAttendees",
            },
        },
        {
            "method": "PATCH",
            "urlTemplate": "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}",
            "bodyTemplate": {"attendees": "{updatedAttendees}"},
        },
    ],
}
conn4 = {"kind": "googlecalendar", "name": "Google Calendar", "authKind": "google-service-account",
         "perUser": True, "boundOperations": [RSVP_OP]}

rsvp_requests = []
ORIGINAL_ATTENDEES = [
    {"email": "me@example.com", "responseStatus": "needsAction"},
    {"email": "other@example.com", "responseStatus": "accepted"},
]


def _rsvp_urlopen(req, timeout=None):  # noqa: ARG001
    rsvp_requests.append(req)
    if req.get_method() == "GET":
        return _FakeResp({"id": "evt-1", "attendees": ORIGINAL_ATTENDEES})
    return _FakeResp({"id": "evt-1", "updated": True})


with patch.object(urllib.request, "urlopen", side_effect=_rsvp_urlopen):
    tools = _build(conn4, caller=lambda: "me@example.com")
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(calendarId="primary", eventId="evt-1", status="accepted")

check("rsvp: two real HTTP calls made (get event, then patch)", len(rsvp_requests) == 2, str(len(rsvp_requests)))
if len(rsvp_requests) == 2:
    patch_req = rsvp_requests[1]
    patch_body = _json.loads(patch_req.data.decode())
    check("rsvp: sends the FULL attendee list, not just mine", len(patch_body.get("attendees", [])) == 2, patch_body)
    me = next((a for a in patch_body["attendees"] if a["email"] == "me@example.com"), None)
    other = next((a for a in patch_body["attendees"] if a["email"] == "other@example.com"), None)
    check("rsvp: MY entry got the new status", me is not None and me["responseStatus"] == "accepted", me)
    check("rsvp: the OTHER attendee's status is untouched", other is not None and other["responseStatus"] == "accepted", other)
check("rsvp: no top-level error", "error" not in result, str(result))

# ── 7. RSVP: caller not actually on the attendee list -> refuses, never silently no-ops ────
with patch.object(urllib.request, "urlopen", side_effect=_rsvp_urlopen):
    tools = _build(conn4, caller=lambda: "stranger@example.com")
    fn = tools[0] if isinstance(tools, list) else tools
    result2 = fn(calendarId="primary", eventId="evt-1", status="accepted")
check(
    "rsvp: a caller who isn't an attendee gets a clear error, not a silent no-op",
    "error" in result2 and "no entry" in result2["error"],
    str(result2),
)

# ── 8. A template referencing an argument the model never supplied refuses clearly -- it
#      must NEVER send the literal "{name}" text as real request data. ────────────────────
FOLDER_OP = {
    "operationId": "CreateFolder",
    "toolName": "create_folder",
    "method": "POST",
    "urlTemplate": "",
    "modelArgs": [
        {"name": "name", "in": "query", "required": True, "type": "string"},
        {"name": "parentId", "in": "query", "required": False, "type": "string"},
    ],
    "auth": "google-oauth",
    "chain": [{
        "method": "POST",
        "urlTemplate": "https://www.googleapis.com/drive/v3/files",
        "bodyTemplate": {"name": "{name}", "parents": ["{parentId}"], "mimeType": "application/vnd.google-apps.folder"},
    }],
}
conn5 = {"kind": "googledrive", "name": "Google Drive", "authKind": "google-service-account", "boundOperations": [FOLDER_OP]}
sent_bodies = []


def _folder_urlopen(req, timeout=None):  # noqa: ARG001
    sent_bodies.append(req.data)
    return _FakeResp({"id": "new-folder-id"})


with patch.object(urllib.request, "urlopen", side_effect=_folder_urlopen):
    tools = _build(conn5)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(name="My Folder")  # parentId deliberately omitted
check(
    "optional-field-omitted: refuses with a clear error instead of sending literal {parentId}",
    "error" in result and "parentId" in result["error"],
    str(result),
)
check("optional-field-omitted: no request was actually sent", len(sent_bodies) == 0, str(sent_bodies))

# ── 9. Gmail create_draft: the encoded MIME message must land NESTED as
#      {"message": {"raw": "..."}}, matching drafts.create's real shape -- not a flat "raw". ──
DRAFT_OP = {
    "operationId": "CreateDraft",
    "toolName": "create_draft",
    "method": "POST",
    "urlTemplate": "",
    "modelArgs": [
        {"name": "userId", "in": "query", "required": True, "type": "string"},
        {"name": "to", "in": "query", "required": True, "type": "string"},
        {"name": "subject", "in": "query", "required": True, "type": "string"},
        {"name": "body", "in": "query", "required": True, "type": "string"},
    ],
    "auth": "google-oauth",
    "chain": [{
        "method": "POST",
        "urlTemplate": "https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts",
        "bodyTemplate": {"message": {}},
        "mimeMessage": {"to": "{to}", "subject": "{subject}", "body": "{body}", "rawField": "message.raw"},
    }],
}
conn6 = {"kind": "gmail", "name": "Gmail", "authKind": "google-service-account", "boundOperations": [DRAFT_OP]}
draft_requests = []


def _draft_urlopen(req, timeout=None):  # noqa: ARG001
    draft_requests.append(req)
    return _FakeResp({"id": "draft-1"})


with patch.object(urllib.request, "urlopen", side_effect=_draft_urlopen):
    tools = _build(conn6)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(userId="me", to="x@example.com", subject="Hi", body="Hello there")

check("create_draft: request was sent", len(draft_requests) == 1, str(len(draft_requests)))
if draft_requests:
    draft_body = _json.loads(draft_requests[0].data.decode())
    check("create_draft: raw is nested under message.raw, not flat", "raw" in draft_body.get("message", {}), draft_body)
    decoded = _base64.urlsafe_b64decode(draft_body["message"]["raw"]).decode("utf-8")
    check("create_draft: MIME body carries the real subject/recipient/text", "Subject: Hi" in decoded and "To: x@example.com" in decoded and "Hello there" in decoded, decoded)
check("create_draft: no top-level error", "error" not in result, str(result))

# ── 10. Gmail send_email: fixed from the live "Invalid JSON payload received" bug -- the
#      model must NOT have to construct MIME/base64 itself. messages.send's raw encoded
#      message is FLAT ({"raw": "..."}), unlike drafts.create's nested message.raw. ──
SEND_OP = {
    "operationId": "SendEmailV2",
    "toolName": "send_email",
    "method": "POST",
    "urlTemplate": "",
    "modelArgs": [
        {"name": "userId", "in": "query", "required": True, "type": "string"},
        {"name": "to", "in": "query", "required": True, "type": "string"},
        {"name": "subject", "in": "query", "required": True, "type": "string"},
        {"name": "body", "in": "query", "required": True, "type": "string"},
    ],
    "auth": "google-oauth",
    "chain": [{
        "method": "POST",
        "urlTemplate": "https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send",
        "bodyTemplate": {},
        "mimeMessage": {"to": "{to}", "subject": "{subject}", "body": "{body}"},
    }],
}
conn7 = {"kind": "gmail", "name": "Gmail", "authKind": "google-service-account", "boundOperations": [SEND_OP]}
send_requests = []


def _send_urlopen(req, timeout=None):  # noqa: ARG001
    send_requests.append(req)
    return _FakeResp({"id": "msg-1"})


with patch.object(urllib.request, "urlopen", side_effect=_send_urlopen):
    tools = _build(conn7)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(userId="me", to="y@example.com", subject="Test", body="Hello")

check("send_email: request was sent", len(send_requests) == 1, str(len(send_requests)))
if send_requests:
    send_body = _json.loads(send_requests[0].data.decode())
    check("send_email: raw is FLAT (top-level), not nested under message", "raw" in send_body and "message" not in send_body, send_body)
    decoded = _base64.urlsafe_b64decode(send_body["raw"]).decode("utf-8")
    check("send_email: MIME body carries the real subject/recipient/text", "Subject: Test" in decoded and "To: y@example.com" in decoded and "Hello" in decoded, decoded)
check("send_email: no top-level error", "error" not in result, str(result))

# ── 11. create_file_by_path: a repeating step that CREATES a missing folder segment
#       instead of refusing -- the new, generic "createIfMissing" capability. ──────────────
CREATE_FILE_BY_PATH_OP = {
    "operationId": "create_file_by_path",
    "toolName": "create_file_by_path",
    "method": "POST",
    "urlTemplate": "",
    "modelArgs": [
        {"name": "folderPath", "in": "query", "required": False, "type": "string"},
        {"name": "name", "in": "query", "required": True, "type": "string"},
        {"name": "content", "in": "query", "required": True, "type": "string"},
        {"name": "mimeType", "in": "query", "required": True, "type": "string"},
    ],
    "auth": "google-oauth",
    "chain": [
        {
            "method": "GET",
            "urlTemplate": "https://www.googleapis.com/drive/v3/files?folderSearch&name=%27{segment}%27&parent=%27{parentId}%27",
            "extractPath": "files",
            "itemIdField": "id",
            "bindAs": "parentId",
            "initialValue": "root",
            "itemNoun": "folder",
            "repeatOverParam": "folderPath",
            "createIfMissing": {
                "method": "POST",
                "urlTemplate": "https://www.googleapis.com/drive/v3/files?createFolder",
                "bodyTemplate": {"name": "{segment}", "parents": ["{parentId}"], "mimeType": "application/vnd.google-apps.folder"},
                "itemIdField": "id",
            },
        },
        {
            "method": "POST",
            "urlTemplate": "https://www.googleapis.com/drive/v3/files?createFileMeta",
            "bodyTemplate": {"name": "{name}", "parents": ["{parentId}"], "mimeType": "{mimeType}"},
            "extractPath": "id",
            "bindAs": "fileId",
        },
        {
            "method": "PATCH",
            "urlTemplate": "https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadMedia",
            "bodyFromParam": "content",
            "bodyContentTypeParam": "mimeType",
        },
    ],
}
conn8 = {"kind": "googledrive", "name": "Google Drive", "authKind": "google-service-account",
         "boundOperations": [CREATE_FILE_BY_PATH_OP]}

# 11a. "Reports" exists, "2026" does not -> only "2026" gets created, chained correctly.
create_folder_requests = []
create_file_requests = []
upload_requests = []


def _route_create_by_path(url, req):  # noqa: ARG001
    if "folderSearch" in url and "Reports" in url:
        return _FakeResp({"files": [{"id": "id-reports"}]})
    if "folderSearch" in url and "2026" in url:
        return _FakeResp({"files": []})
    if "createFolder" in url:
        create_folder_requests.append(req)
        return _FakeResp({"id": "id-2026-new", "name": "2026"})
    if "createFileMeta" in url:
        create_file_requests.append(req)
        return _FakeResp({"id": "id-new-file", "name": "test.txt"})
    if "uploadMedia" in url:
        upload_requests.append(req)
        return _FakeResp({"id": "id-new-file", "name": "test.txt", "webViewLink": "https://..."})
    raise AssertionError(f"no route matched URL: {url}")


def _fake_urlopen_create(req, timeout=None):  # noqa: ARG001
    return _route_create_by_path(req.full_url, req)


with patch.object(urllib.request, "urlopen", side_effect=_fake_urlopen_create):
    tools = _build(conn8)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(folderPath="Reports/2026", name="test.txt", content="hello", mimeType="text/plain")

check("create_file_by_path: missing folder got created", len(create_folder_requests) == 1, str(len(create_folder_requests)))
if create_folder_requests:
    folder_body = _json.loads(create_folder_requests[0].data.decode())
    check("create_file_by_path: created folder named correctly", folder_body.get("name") == "2026", folder_body)
    check("create_file_by_path: created folder under the RESOLVED existing parent", folder_body.get("parents") == ["id-reports"], folder_body)
check("create_file_by_path: file metadata created under the NEW folder", len(create_file_requests) == 1, str(len(create_file_requests)))
if create_file_requests:
    file_body = _json.loads(create_file_requests[0].data.decode())
    check("create_file_by_path: file parented to the newly-created folder", file_body.get("parents") == ["id-2026-new"], file_body)
check("create_file_by_path: content uploaded to the new file", len(upload_requests) == 1, str(len(upload_requests)))
if upload_requests:
    check("create_file_by_path: uploaded content is the real text, not JSON-wrapped", upload_requests[0].data == b"hello", upload_requests[0].data)
check("create_file_by_path: no top-level error", "error" not in result, str(result))

# 11b. Empty folderPath -> no folder resolution at all, file created directly under "root".
create_folder_requests.clear()
create_file_requests.clear()
upload_requests.clear()
with patch.object(urllib.request, "urlopen", side_effect=_fake_urlopen_create):
    tools = _build(conn8)
    fn = tools[0] if isinstance(tools, list) else tools
    result = fn(folderPath="", name="root-file.txt", content="hi", mimeType="text/plain")
check("create_file_by_path: empty folderPath makes zero folder calls", len(create_folder_requests) == 0, str(len(create_folder_requests)))
if create_file_requests:
    root_file_body = _json.loads(create_file_requests[0].data.decode())
    check("create_file_by_path: empty folderPath parents the file to 'root'", root_file_body.get("parents") == ["root"], root_file_body)
check("create_file_by_path: no top-level error on empty folderPath", "error" not in result, str(result))

# ── 12. get_current_datetime: a LOCAL COMPUTATION step, no HTTP call at all ────────────────
GET_CURRENT_DATETIME_OP = {
    "operationId": "get_current_datetime",
    "toolName": "get_current_datetime",
    "method": "POST",
    "urlTemplate": "",
    "modelArgs": [{"name": "timezone", "in": "query", "required": False, "type": "string"}],
    "auth": "google-oauth",
    "chain": [{"localCompute": {"kind": "current_datetime", "timezoneParam": "timezone", "bindAs": "now"}}],
}
conn9 = {"kind": "googlecalendar", "name": "Google Calendar", "authKind": "google-service-account",
         "boundOperations": [GET_CURRENT_DATETIME_OP]}


def _fail_if_called(req, timeout=None):  # noqa: ARG001
    raise AssertionError("get_current_datetime made a real HTTP call -- it must not")


with patch.object(urllib.request, "urlopen", side_effect=_fail_if_called):
    tools = _build(conn9)
    fn = tools[0] if isinstance(tools, list) else tools
    utc_result = fn()
    ist_result = fn(timezone="Asia/Kolkata")
    bad_tz_result = fn(timezone="Not/AZone")

check("get_current_datetime: no HTTP call made at all", "error" not in utc_result, str(utc_result))
check("get_current_datetime: returns a datetime string", bool(utc_result.get("body", {}).get("datetime")), str(utc_result))
check("get_current_datetime: defaults to UTC with no timezone given", utc_result.get("body", {}).get("timezone") == "UTC", str(utc_result))
check("get_current_datetime: a named IANA zone changes the offset", ist_result.get("body", {}).get("timezone") not in (None, "UTC"), str(ist_result))
check("get_current_datetime: an unknown zone name falls back to UTC, not an error", "error" not in bad_tz_result, str(bad_tz_result))

print(f"\n{len(failures)} failure(s) out of a full run." if failures else "\nAll checks passed.")
sys.exit(1 if failures else 0)
