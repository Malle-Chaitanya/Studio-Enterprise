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

        try:
            base_url = secret("base_url").rstrip("/")
            email = secret("email")
            token = secret("api_token")
        except Exception as e:  # noqa: BLE001
            return {"error": f"credential lookup failed: {e}"}

        auth = base64.b64encode(f"{email}:{token}".encode()).decode()
        cql = urllib.parse.quote(f'text ~ "{query}"')
        url = f"{base_url}/wiki/rest/api/content/search?cql={cql}&limit=5&expand=body.storage,space"
        req = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                payload = _json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            return {"error": f"confluence request failed: {e}"}

        results = []
        for item in payload.get("results", []):
            html = ((item.get("body") or {}).get("storage") or {}).get("value") or ""
            text = re.sub(r"<[^>]+>", " ", html)
            text = re.sub(r"\s+", " ", text).strip()
            results.append({
                "title": item.get("title"),
                "space": ((item.get("space") or {}).get("name")),
                "url": f"{base_url}/wiki{((item.get('_links') or {}).get('webui') or '')}",
                "excerpt": text[:1500],
            })
        return {"results": results, "count": len(results)}

    return confluence_live_search
