"""A model argument whose placeholder lives inside the URL must be SUBSTITUTED there.

Regression test for a bug the offline verifier structurally could not see. A map entry may
interpolate a model argument inside another parameter's template -- Drive's path lookup
builds ``q="name = '{path}' and trashed = false"`` -- so ``path`` is declared ``in: query``
while its placeholder sits in the URL. The executor routed it only by its declared ``in``,
so the URL kept a literal ``{path}`` and the call died with "missing required value(s) for
path" before it ever left the process.

Every ByPath operation was affected, and every structural check passed: the placeholder WAS
filled by a declared argument, so the names lined up and only the mechanics were wrong.
Found by executing a mapped operation against the live vendor, which is the only gate that
can see this class at all.
"""
import json
import sys
import types
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from connector_tools.generic_rest import build_tools  # noqa: E402


def _fake_urlopen(captured):
    """Capture the URL the executor built, and answer with an empty Drive-shaped result."""
    class _Resp:
        status = 200
        def read(self): return json.dumps({"files": [{"id": "FILE_ID"}]}).encode()
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def _open(req, timeout=None):
        captured.append(req.full_url)
        return _Resp()
    return _open


def _run(op, kwargs, monkeypatch):
    captured = []
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen(captured))
    conn = {"kind": "googledrive", "name": "shared_googledrive",
            "authKind": "bearer", "boundOperations": [op]}
    tools = build_tools(conn, lambda f: "", lambda *a, **k: "T",
                        lambda fill: "Bearer T", lambda t: t)
    tools[0](**kwargs)
    return captured


BY_PATH = {
    "toolName": "get_file_metadata_by_path",
    "connectorId": "shared_googledrive",
    "operationId": "GetFileMetadataByPath",
    "method": "GET",
    # `path` is declared in: query, but the mapping puts {path} INSIDE the q template.
    "urlTemplate": "https://www.googleapis.com/drive/v3/files?q=name%20%3D%20'{path}'",
    "description": "",
    "fixedArgs": {},
    "modelArgs": [{"name": "path", "in": "query", "required": True, "type": "string"}],
    "contextRequired": [], "contextValues": {}, "auth": "google-oauth",
}


def test_query_declared_argument_is_substituted_into_the_url(monkeypatch):
    urls = _run(BY_PATH, {"path": "report.docx"}, monkeypatch)
    assert urls, "the executor never issued a request"
    url = urls[0]
    assert "{path}" not in url, f"placeholder left unresolved: {url}"
    assert "report.docx" in url, f"value never reached the URL: {url}"
    # Routing it as a separate parameter as WELL would send a stray `path=` the vendor
    # never declared -- the other half of the same bug.
    assert "path=report.docx" not in url, f"stray query parameter: {url}"


def test_path_declared_argument_still_works(monkeypatch):
    op = dict(BY_PATH)
    op["urlTemplate"] = "https://www.googleapis.com/drive/v3/files/{id}"
    op["modelArgs"] = [{"name": "id", "in": "path", "required": True, "type": "string"}]
    urls = _run(op, {"id": "abc123"}, monkeypatch)
    assert urls[0].endswith("/files/abc123"), urls[0]


# ---------------------------------------------------------------------------------------
# A declared status selects the alternative call; nothing else does.
# ---------------------------------------------------------------------------------------

def _failing_then_ok(captured, fail_status):
    """First call raises the given HTTP status, second succeeds. Mirrors Drive refusing
    `alt=media` on a Google Doc and accepting `files.export` for the same file."""
    import urllib.error

    state = {"n": 0}

    class _Resp:
        status = 200
        def read(self): return b'{"ok": true}'
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def _open(req, timeout=None):
        captured.append(req.full_url)
        state["n"] += 1
        if state["n"] == 1:
            raise urllib.error.HTTPError(req.full_url, fail_status, "refused", {}, None)
        return _Resp()
    return _open


CONTENT = {
    "toolName": "get_file_content",
    "connectorId": "shared_googledrive",
    "operationId": "GetFileContent",
    "method": "GET",
    "urlTemplate": "https://www.googleapis.com/drive/v3/files/{id}?alt=media",
    "description": "", "fixedArgs": {},
    "modelArgs": [{"name": "id", "in": "path", "required": True, "type": "string"}],
    "contextRequired": [], "contextValues": {}, "auth": "google-oauth",
    "steps": [{
        "method": "GET",
        "urlTemplate": "https://www.googleapis.com/drive/v3/files/{id}?alt=media",
        "fallback": {
            "whenStatus": [403],
            "step": {"method": "GET",
                     "urlTemplate": "https://www.googleapis.com/drive/v3/files/{id}/export?mimeType=application%2Fpdf"},
        },
    }],
}


def test_declared_status_runs_the_alternative(monkeypatch):
    captured = []
    monkeypatch.setattr(urllib.request, "urlopen", _failing_then_ok(captured, 403))
    conn = {"kind": "googledrive", "name": "shared_googledrive", "authKind": "bearer",
            "boundOperations": [CONTENT]}
    tools = build_tools(conn, lambda f: "", lambda *a, **k: "T", lambda fill: "Bearer T", lambda t: t)
    res = tools[0](id="abc")
    assert len(captured) == 2, f"the alternative never ran: {captured}"
    assert "alt=media" in captured[0]
    assert "/export" in captured[1], captured[1]
    assert res.get("status") == 200, res


def test_an_undeclared_status_does_not(monkeypatch):
    # 404 is not in whenStatus. A fallback that fires on any failure is a blanket retry,
    # which hides real faults -- the behaviour this test exists to prevent.
    captured = []
    monkeypatch.setattr(urllib.request, "urlopen", _failing_then_ok(captured, 404))
    conn = {"kind": "googledrive", "name": "shared_googledrive", "authKind": "bearer",
            "boundOperations": [CONTENT]}
    tools = build_tools(conn, lambda f: "", lambda *a, **k: "T", lambda fill: "Bearer T", lambda t: t)
    res = tools[0](id="abc")
    assert len(captured) == 1, f"the alternative ran for an undeclared status: {captured}"
    assert "error" in res
