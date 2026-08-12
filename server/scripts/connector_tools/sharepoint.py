"""SharePoint/OneDrive live tools, SCOPED to the folder the source agent named.
See connectors/confluence.py's module docstring for the shared build_tools
contract every connector module in this package follows.

Purpose-built rather than the generic REST fallback for two reasons:
  1. Scope. An app credential with Sites.Read.All can reach every site in the
     tenant (99 in the test tenant). The source Copilot agent pointed at ONE
     folder, so the migrated agent must be confined to that folder — a tool
     that cannot express a wider path is a stronger guarantee than an
     instruction asking it not to wander.
  2. Reading files. Graph returns raw bytes; the model needs text. Extraction
     (pdf/docx/xlsx) has to happen in the container.
"""


def build_tools(conn, secret, mint_token, auth_header, fill):
    scope_uri = conn.get("scopeUri") or ""

    def _graph(path: str, token: str, raw: bool = False):
        import json as _json
        import urllib.request
        req = urllib.request.Request(
            f"https://graph.microsoft.com/v1.0{path}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        return data if raw else _json.loads(data.decode("utf-8"))

    def _resolve_scope(token: str):
        """Turn the SharePoint URL into (siteId, folderPath). Cached per container."""
        import urllib.parse
        if not scope_uri:
            return None, ""
        p = urllib.parse.urlparse(scope_uri)
        host = p.netloc
        parts = [urllib.parse.unquote(x) for x in p.path.split("/") if x]
        # .../sites/<name>/<library>/<folders...>  or  /<library>/<folders...>
        if parts and parts[0].lower() == "sites" and len(parts) >= 2:
            site_path = f"/sites/{parts[1]}"
            rest = parts[2:]
        else:
            site_path = ""
            rest = parts
        site = _graph(f"/sites/{host}:{site_path}" if site_path else f"/sites/{host}", token)
        # Drop the document-library segment ("Shared Documents"); what remains is the
        # folder path inside the default drive.
        if rest and rest[0].lower() in ("shared documents", "documents", "shared%20documents"):
            rest = rest[1:]
        return site.get("id"), "/".join(rest)

    def _scoped_path(folder: str, user_path: str) -> str:
        """Join a model-supplied relative path onto the scoped folder, rejecting
        any attempt to escape it. The tool signature only documents "a path inside
        the connected folder" as a convention — nothing stops the calling model
        from passing "../../other-site" instead, so this is enforced here rather
        than trusted from the docstring.

        Checked by containment (resolved candidate must equal `folder` or sit
        under it), not just by pattern-matching for ".." — a bare ".." against a
        single-segment folder normalizes straight to ".", which slips past a
        ".."-prefix check while still resolving outside the intended scope.
        """
        import posixpath
        folder = (folder or "").strip("/")
        candidate = posixpath.normpath(posixpath.join(folder, user_path.strip("/").lstrip("/")))
        candidate = "" if candidate == "." else candidate.strip("/")
        escapes = (
            posixpath.isabs(user_path)
            or candidate == ".."
            or candidate.startswith("../")
            or (folder and candidate != folder and not candidate.startswith(folder + "/"))
        )
        if escapes:
            raise ValueError(f"path '{user_path}' escapes the connected SharePoint folder")
        return candidate

    def sharepoint_list_files(subfolder: str = "") -> dict:
        """List files and folders in the company's SharePoint folder this agent is
        connected to. Only this folder and things inside it are accessible.

        Args:
            subfolder: optional path INSIDE the connected folder, e.g. "Reports/2026".

        Returns:
            dict with `items` (name, isFolder, size, lastModified, id) or `error`.
        """
        try:
            token = mint_token(fill)
            site_id, folder = _resolve_scope(token)
            if not site_id:
                return {"error": "no SharePoint scope configured for this agent"}
            path = _scoped_path(folder, subfolder)
            url = (
                f"/sites/{site_id}/drive/root:/{path}:/children"
                if path else f"/sites/{site_id}/drive/root/children"
            )
            data = _graph(url, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"SharePoint list failed: {e}"}
        items = [{
            "name": i.get("name"),
            "isFolder": "folder" in i,
            "size": i.get("size"),
            "lastModified": i.get("lastModifiedDateTime"),
            "id": i.get("id"),
        } for i in data.get("value", [])]
        return {"folder": scope_uri, "subfolder": subfolder, "items": items, "count": len(items)}

    def sharepoint_read_file(file_path: str) -> dict:
        """Read the TEXT CONTENT of a file in the connected SharePoint folder, so you
        can answer questions about what a document says.

        Supports .txt .md .csv .json .log .xml, PDF, Word (.docx) and Excel (.xlsx).
        Images and other binary formats cannot be read.

        Args:
            file_path: file name, or path inside the connected folder,
                e.g. "daily_queries.txt" or "Reports/Q1.pdf".

        Returns:
            dict with `text` (extracted, possibly truncated) or `error`.
        """
        import io
        MAX_BYTES = 20 * 1024 * 1024
        MAX_CHARS = 60000
        try:
            token = mint_token(fill)
            site_id, folder = _resolve_scope(token)
            if not site_id:
                return {"error": "no SharePoint scope configured for this agent"}
            full = _scoped_path(folder, file_path)
            meta = _graph(f"/sites/{site_id}/drive/root:/{full}", token)
            size = meta.get("size") or 0
            if size > MAX_BYTES:
                return {"error": f"file is {size} bytes, too large to read inline"}
            blob = _graph(f"/sites/{site_id}/drive/root:/{full}:/content", token, raw=True)
        except Exception as e:  # noqa: BLE001
            return {"error": f"SharePoint read failed: {e}"}

        name = (meta.get("name") or file_path).lower()
        try:
            if name.endswith((".txt", ".md", ".csv", ".json", ".log", ".xml", ".yaml", ".yml")):
                text = blob.decode("utf-8", errors="replace")
            elif name.endswith(".pdf"):
                from pypdf import PdfReader
                reader = PdfReader(io.BytesIO(blob))
                text = "\n".join((pg.extract_text() or "") for pg in reader.pages)
            elif name.endswith(".docx"):
                import docx
                doc = docx.Document(io.BytesIO(blob))
                # .paragraphs alone misses tables entirely — python-docx does not
                # walk them as paragraphs. Confirmed live 2026-08-11: a file whose
                # real content lived in a table returned only its plain-text
                # headings, silently dropping everything else.
                parts = [p.text for p in doc.paragraphs if p.text]
                for i, table in enumerate(doc.tables):
                    parts.append(f"# table {i + 1}")
                    for row in table.rows:
                        # A multi-paragraph cell's OWN text contains \n — join with the
                        # same character as rows and a 10-paragraph cell becomes 9 fake
                        # extra rows, scrambling the table (confirmed live 2026-08-11
                        # against a real file with multi-paragraph "Summary" cells).
                        cells = [c.text.replace("\n", " ").strip() for c in row.cells]
                        parts.append(" | ".join(cells))
                text = "\n".join(parts)
            elif name.endswith(".xlsx"):
                import openpyxl
                wb = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True)
                rows = []
                for ws in wb.worksheets:
                    rows.append(f"# sheet: {ws.title}")
                    for row in ws.iter_rows(values_only=True):
                        rows.append(", ".join("" if c is None else str(c) for c in row))
                text = "\n".join(rows)
            else:
                return {"error": f"cannot extract text from '{meta.get('name')}' "
                                 f"— unsupported format. Only text, PDF, Word and Excel are readable."}
        except Exception as e:  # noqa: BLE001
            return {"error": f"text extraction failed for {meta.get('name')}: {e}"}

        truncated = len(text) > MAX_CHARS
        return {
            "file": meta.get("name"),
            "webUrl": meta.get("webUrl"),
            "truncated": truncated,
            "text": text[:MAX_CHARS],
        }

    return [sharepoint_list_files, sharepoint_read_file]
