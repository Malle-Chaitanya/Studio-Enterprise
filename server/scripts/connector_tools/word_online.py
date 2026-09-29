"""Word Online (Business) live tool. See connectors/confluence.py's module docstring
for the shared build_tools contract every connector module in this package follows.

WHY THIS IS HAND-WRITTEN, NOT THE GENERIC REST FALLBACK. Every one of this connector's
captured operations (GetFilePDF, CreateWordFileWithContent, GetDrives, ListFolder, ...)
routes through '/{connectionId}/api/templates/...' or '/{connectionId}/codeless/v1.0/...'.
That connectionId addresses Microsoft's own Power Automate document-conversion service —
a real backend, but one only reachable through a connectionId object created by a signed-in
person clicking through Copilot Studio's OAuth popup. There is no public host behind it a
service-principal bearer token can call directly. Confirmed live 2026-09-24: a Tier-2 tool
built against graph.microsoft.com for 'GetFilePDF' never actually worked (see
operationBinding.ts's shared_wordonlinebusiness VENDOR_BINDINGS entry).

`word_online_convert_to_pdf` reproduces the ONE operation real staged agents use — measured
the same way SharePoint's `sharepoint_list_lists` was (see sharepoint.py) — using Microsoft
Graph's own, genuinely public APIs instead of the connector's internal path:
  1. `POST /search/query` (Microsoft Search API, entityTypes=driveItem) to find the file
     tenant-wide by name — proven live 2026-09-24. App-only search REQUIRES a `region`;
     the tenant's own valid region is unknown up front, so the first call's rejection names
     it ("Only valid regions are X") and the second call uses it. Not a guess: Microsoft's
     own error message is the source of truth here.
  2. `GET /drives/{drive-id}/items/{item-id}/content?format=pdf` on the found item — proven
     live 2026-09-24 against a real .docx, returning a real, correctly-sized PDF.
This performs the identical server-side Office-to-PDF conversion the source operation did,
and accepts the app credential directly (Files.Read.All / Files.ReadWrite.All, application
permission) — no connectionId, no signed-in person required.

SCOPE. The source connector's captured tool has no fixed file reference (Copilot let the
signed-in user name any file they could see); there is no per-agent scope to carry over the
way SharePoint's folder scope is. The migrated tool searches the whole tenant with the app's
own Files.Read.All grant, which is broader than one person's own OneDrive — the same
narrowing tradeoff SharePoint's GetAllTables mapping documents, and consistent with this
connector's already-declared broad permission (registry.ts: Files.ReadWrite.All, tenant-wide).
"""

_DEFAULT_REGION = "NAM"


def build_tools(conn, secret, mint_token, auth_header, fill):
    def _graph_json(method: str, path: str, token: str, body=None):
        import json as _json
        import urllib.request
        data = _json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            f"https://graph.microsoft.com/v1.0{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if data else {}),
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return _json.loads(resp.read().decode("utf-8"))

    def _search_driveitem(query: str, token: str) -> list:
        """POST /search/query for a file by name, tenant-wide. Region is required for
        application-permission requests and varies per tenant, so the first attempt uses a
        common default and, if Microsoft names the real region in its rejection, retries once
        with that region rather than hard-coding a value that only works for one tenant.
        """
        import json as _json
        import urllib.error
        import urllib.request

        def _attempt(region: str):
            req = urllib.request.Request(
                "https://graph.microsoft.com/v1.0/search/query",
                data=_json.dumps({
                    "requests": [{
                        "entityTypes": ["driveItem"],
                        "query": {"queryString": query},
                        "from": 0,
                        "size": 5,
                        "region": region,
                    }],
                }).encode("utf-8"),
                method="POST",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return _json.loads(resp.read().decode("utf-8"))

        try:
            result = _attempt(_DEFAULT_REGION)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            import re as _re
            m = _re.search(r"Only valid regions are (\w+)", body)
            if not m:
                raise
            result = _attempt(m.group(1))

        hits = []
        for container in (result.get("value") or [{}])[0].get("hitsContainers", []):
            for hit in container.get("hits", []):
                res = hit.get("resource") or {}
                if res.get("@odata.type") == "#microsoft.graph.driveItem":
                    hits.append(res)
        return hits

    def word_online_convert_to_pdf(file_name: str) -> dict:
        """Convert a Word document to PDF.

        Searches the connected Microsoft 365 tenant for a file matching the given name,
        then asks Microsoft Graph to render it as a PDF. Only .docx/.doc files convert.

        Args:
            file_name: the Word document's name, e.g. "Q3 Report.docx", or enough of it
                to uniquely identify the file.

        Returns:
            dict with `file` (name and webUrl of the source document) and `pdfSizeBytes`
            confirming the conversion succeeded, or `error`.
        """
        try:
            token = mint_token(fill)
            hits = _search_driveitem(file_name.strip(), token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Word Online: search for '{file_name}' failed: {e}"}

        docs = [h for h in hits if str(h.get("name", "")).lower().endswith((".docx", ".doc"))]
        if not docs:
            return {"error": f"no Word document matching '{file_name}' was found"}
        # An exact (case-insensitive) name match wins over a loose full-text hit, so asking
        # for "Report.docx" does not convert some unrelated "Old Report.docx" that merely
        # mentions the same words.
        exact = [d for d in docs if str(d.get("name", "")).lower() == file_name.strip().lower()]
        item = (exact or docs)[0]

        drive_id = (item.get("parentReference") or {}).get("driveId")
        item_id = item.get("id")
        if not drive_id or not item_id:
            return {"error": f"found '{item.get('name')}' but Graph did not return its drive location"}

        try:
            import urllib.request
            req = urllib.request.Request(
                f"https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{item_id}/content?format=pdf",
                headers={"Authorization": f"Bearer {token}"},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                pdf_bytes = resp.read()
        except Exception as e:  # noqa: BLE001
            return {"error": f"Word Online: conversion of '{item.get('name')}' failed: {e}"}

        return {
            "file": {"name": item.get("name"), "webUrl": item.get("webUrl")},
            "pdfSizeBytes": len(pdf_bytes),
            "note": "Converted successfully. The PDF itself is not stored anywhere new — "
                    "this confirms the conversion works and the source document's webUrl "
                    "above opens the original.",
        }

    return [word_online_convert_to_pdf]
