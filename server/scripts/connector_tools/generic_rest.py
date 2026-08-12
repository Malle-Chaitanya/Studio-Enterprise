"""Generic REST connector fallback: base URL + auth header from the registry,
used for any connector kind without a purpose-built module. See connectors/
package docstring in confluence.py for the shared build_tools contract.
"""


def build_tools(conn, secret, mint_token, auth_header, fill):
    base_url_tpl = conn.get("baseUrlTemplate") or ""
    conn_name = conn.get("name") or conn.get("kind") or conn.get("id") or "connector"
    auth_kind = conn.get("authKind") or "bearer"

    def call_external_api(path: str, method: str = "GET", body: str = "") -> dict:
        """Call the configured external system's REST API on the user's behalf.

        Args:
            path: path (and query string) appended to the connector's base URL.
            method: HTTP method, e.g. GET or POST.
            body: JSON request body as a string, for POST/PUT.

        Returns:
            dict with `status` and `body`, or `error`.
        """
        import json as _json
        import urllib.request

        try:
            base = fill(base_url_tpl).rstrip("/")
            header = auth_header(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed ({auth_kind}): {e}"}

        headers = {"Accept": "application/json"}
        if header:
            headers["Authorization"] = header
        data = body.encode("utf-8") if body else None
        if data:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(f"{base}/{path.lstrip('/')}", data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                raw = resp.read().decode("utf-8")
                try:
                    return {"status": resp.status, "body": _json.loads(raw)}
                except Exception:  # noqa: BLE001
                    return {"status": resp.status, "body": raw[:4000]}
        except Exception as e:  # noqa: BLE001
            return {"error": f"{conn_name} request failed: {e}"}

    return call_external_api
