"""Confluence live-tool: one function, live-searches the customer's Confluence
instance. Moved out of adk_deploy.py's _build_live_connector_tool so a change
to one connector can't accidentally break another (server/scripts/adk_deploy.py
used to be a single ~1600-line file with every connector's tool code inline in
one dispatch-by-kind function).

Contract every connector module in this package follows:
    build_tools(conn, secret, mint_token, auth_header, fill) -> Callable | list[Callable]
Each parameter is one of the shared closures adk_deploy.py's
_build_live_connector_tool used to define inline — now passed in explicitly so
this module has no hidden dependency on the caller's local variables.
"""


def build_tools(conn, secret, mint_token, auth_header, fill):
    def confluence_live_search(query: str) -> dict:
        """Search the company's LIVE Confluence instance and return matching page
        titles with their current text. Use this for content that may be newer
        than the indexed knowledge base, or in spaces the knowledge base does not
        cover.

        Args:
            query: free-text search terms, e.g. "python coding standards".

        Returns:
            dict with `results` (list of {title, space, url, excerpt}) or `error`.
        """
        import base64
        import json as _json
        import re
        import urllib.parse
        import urllib.request

        LIMIT = 5
        EXCERPT_CHARS = 1500

        try:
            # A customer who pastes the site URL with /wiki already on it would otherwise
            # get /wiki/wiki/rest/... — a 404 the model reports as "nothing found", which
            # reads like an empty Confluence.
            base_url = secret("base_url").rstrip("/")
            if base_url.lower().endswith("/wiki"):
                base_url = base_url[: -len("/wiki")]
            email = secret("email")
            token = secret("api_token")
        except Exception as e:  # noqa: BLE001
            return {"error": f"credential lookup failed: {e}"}

        auth = base64.b64encode(f"{email}:{token}".encode()).decode()
        # `query` reaches here from the MODEL, which means from whoever is talking to the
        # agent. Interpolated raw, a quote closes the CQL literal and the rest of the
        # sentence becomes operators: `x" or space = "HR` is a valid query for a space
        # this search was never meant to touch. Escape the two characters CQL treats as
        # structural, backslash first so the quote escape survives it.
        safe = query.replace("\\", "\\\\").replace('"', '\\"')[:500]
        if not safe.strip():
            return {"error": "confluence search needs a non-empty query"}
        cql = urllib.parse.quote(f'text ~ "{safe}"')
        # body.view, not body.storage: storage format keeps macros as unrendered XML, so a
        # page whose content IS a table or an excerpt macro stripped down to an empty
        # string and the model reported the page as blank.
        url = f"{base_url}/wiki/rest/api/content/search?cql={cql}&limit={LIMIT}&expand=body.view,space"
        req = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                payload = _json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            # Quote what Confluence said. `str(e)` for urllib is "HTTP Error 403:
            # Forbidden" with the body thrown away, and 403 (the account has no Confluence
            # access) needs a different fix from 401 (bad token) — the distinction the
            # credential validator already makes for this exact API.
            try:
                detail = e.read().decode("utf-8")[:400]  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                detail = str(e)
            status = getattr(e, "code", None)
            if status == 401:
                return {"error": f"Confluence rejected the stored email/API token pair ({base_url})."}
            if status == 403:
                return {"error": f"The Confluence account {email} is not allowed to read this content ({base_url})."}
            return {"error": f"confluence request failed: {detail}"}

        results = []
        truncated_pages = []
        for item in payload.get("results", []):
            html = ((item.get("body") or {}).get("view") or {}).get("value") or ""
            text = re.sub(r"<[^>]+>", " ", html)
            text = re.sub(r"\s+", " ", text).strip()
            title = item.get("title")
            if len(text) > EXCERPT_CHARS:
                truncated_pages.append(title)
            results.append({
                "title": title,
                "space": ((item.get("space") or {}).get("name")),
                "url": f"{base_url}/wiki{((item.get('_links') or {}).get('webui') or '')}",
                "excerpt": text[:EXCERPT_CHARS],
            })
        out = {"results": results, "count": len(results)}
        # Say when the answer is partial. Silent truncation lets the model present half a
        # policy page as the whole policy, and a top-N cut as "these are all of them" —
        # the fidelity failure this codebase refuses everywhere else.
        if truncated_pages:
            out["truncated"] = truncated_pages
            out["note"] = (
                f"Excerpts were cut to {EXCERPT_CHARS} characters for: "
                + ", ".join(str(t) for t in truncated_pages)
                + ". Read the page URL for the full text."
            )
        if len(results) >= LIMIT:
            out["note_more"] = f"Only the top {LIMIT} matches are shown; there may be more."
        return out

    return confluence_live_search
