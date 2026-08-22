"""Confluence live-tools: search, list spaces, list pages in a space, read one page.

Four tools rather than one because that is what real agents call. Measured across 151
staged agents: GetPages (27 agents), GetSpaces (18), GetPageMetadata (16),
GetPagesBySpace (14) - and until 2026-08-20 the only tool here was a text search, so
three of those four had no tool at all and were reported as unmigrated capability. Moved out of adk_deploy.py's _build_live_connector_tool so a change
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

    # ---- shared helpers -------------------------------------------------------------
    #
    # NESTED INSIDE build_tools, not module-level, and this is not a style choice:
    # cloudpickle serialises a nested closure BY VALUE and a module-level function BY
    # REFERENCE. A module-level helper is therefore not shipped inside the Reasoning Engine
    # pickle, and every tool calling it fails at inference with NameError while working
    # perfectly on the machine that deployed it.

    def _creds():
        """base_url (normalised), email, api token."""
        base_url = secret("base_url").rstrip("/")
        # A customer who pastes the site URL with /wiki already on it would otherwise get
        # /wiki/wiki/rest/... - a 404 the model reports as "nothing found", which reads
        # like an empty Confluence.
        if base_url.lower().endswith("/wiki"):
            base_url = base_url[: -len("/wiki")]
        return base_url, secret("email"), secret("api_token")

    def _get(url):
        """GET and parse, turning Confluence errors into ones a customer can act on."""
        import base64
        import json as _json
        import urllib.request

        base_url, email, token = _creds()
        auth = base64.b64encode(f"{email}:{token}".encode()).decode()
        req = urllib.request.Request(
            url, headers={"Authorization": f"Basic {auth}", "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                return _json.loads(resp.read().decode("utf-8")), None
        except Exception as e:  # noqa: BLE001
            # 401 (bad token) and 403 (account has no Confluence access) need different
            # fixes, so they must not collapse into one message. str(e) for urllib throws
            # the response body away, hence the explicit read.
            try:
                detail = e.read().decode("utf-8")[:300]  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                detail = str(e)
            status = getattr(e, "code", None)
            if status == 401:
                return None, f"Confluence rejected the stored email/API token pair ({base_url})."
            if status == 403:
                return None, f"The Confluence account {email} is not allowed to read this ({base_url})."
            if status == 404:
                return None, f"Confluence returned 404 ({base_url}) - check the space key or page id."
            return None, f"confluence request failed: {detail}"

    def _strip_html(html):
        import re as _re

        text = _re.sub(r"<[^>]+>", " ", html or "")
        return _re.sub(r"\s+", " ", text).strip()

    def _resolve_space(space):
        """Accept a space KEY or a human space NAME, and return the key.

        Customers know spaces by name ("Migration Knowledge Source"); the API keys off an
        opaque key. Passing a name straight through produced "None of the requested spaces
        found" - which reads as an empty Confluence rather than a lookup needing one more
        step, and is exactly how the knowledge path has been failing. Ambiguity is refused
        rather than guessed: picking one of two same-named spaces silently answers from the
        wrong documentation.
        """
        wanted = (space or "").strip()
        if not wanted:
            return None, "a space key or space name is required"
        base_url = _creds()[0]
        seen = []
        start = 0
        # 10 pages x 100 - enough for a large site, bounded so a paging bug cannot spin.
        for _ in range(10):
            data, err = _get(f"{base_url}/wiki/rest/api/space?limit=100&start={start}")
            if err:
                return None, err
            batch = data.get("results", [])
            if not batch:
                break
            for sp in batch:
                key, name = sp.get("key"), sp.get("name")
                if key == wanted:
                    return key, None
                seen.append((key, name))
            if len(batch) < 100:
                break
            start += len(batch)
        exact = [k for k, n in seen if (n or "").strip().lower() == wanted.lower()]
        if len(exact) == 1:
            return exact[0], None
        if len(exact) > 1:
            return None, f'Several spaces are named "{wanted}". Use the space key: {", ".join(exact[:6])}'
        partial = [(k, n) for k, n in seen if wanted.lower() in (n or "").lower()]
        if len(partial) == 1:
            return partial[0][0], None
        if len(partial) > 1:
            names = ", ".join(f'"{n}" ({k})' for k, n in partial[:6])
            return None, f'"{wanted}" matches several spaces: {names}. Use the exact name or the key.'
        return None, f'No space called "{wanted}". Use confluence_list_spaces to see what exists.'

    # ---- GetSpaces ------------------------------------------------------------------
    def confluence_list_spaces(max_results: int = 50) -> dict:
        """List the Confluence spaces this account can see, with their keys and names.

        Use this first when the user names a space, or to find out what documentation
        exists at all.

        Args:
            max_results: how many spaces to return (1-100, default 50).

        Returns:
            dict with `spaces` (list of {key, name, type}) and `count`, or `error`.
        """
        try:
            limit = max(1, min(int(max_results or 50), 100))
        except (TypeError, ValueError):
            limit = 50
        base_url = _creds()[0]
        data, err = _get(f"{base_url}/wiki/rest/api/space?limit={limit}")
        if err:
            return {"error": err}
        spaces = [
            {"key": sp.get("key"), "name": sp.get("name"), "type": sp.get("type")}
            for sp in data.get("results", [])
        ]
        out = {"spaces": spaces, "count": len(spaces)}
        # A personal space is a user's own area and is rarely what anyone means by "our
        # documentation", so say which these are rather than letting them pad the list.
        personal = [sp["key"] for sp in spaces if str(sp.get("key") or "").startswith("~")]
        if personal:
            out["note"] = (
                f"{len(personal)} of these are personal spaces (keys beginning '~'), "
                "not team documentation."
            )
        if len(spaces) >= limit:
            out["note_more"] = f"Only the first {limit} spaces are shown; there may be more."
        return out

    # ---- GetPagesBySpace ------------------------------------------------------------
    def confluence_list_pages_in_space(space: str, max_results: int = 25) -> dict:
        """List the pages in one Confluence space. Accepts the space NAME or its key.

        Args:
            space: space name ("Engineering Docs") or key ("ENG").
            max_results: how many pages to return (1-100, default 25).

        Returns:
            dict with `pages` (list of {id, title, url}), `space`, `count`, or `error`.
        """
        key, err = _resolve_space(space)
        if err:
            return {"error": err}
        try:
            limit = max(1, min(int(max_results or 25), 100))
        except (TypeError, ValueError):
            limit = 25
        base_url = _creds()[0]
        data, err = _get(
            f"{base_url}/wiki/rest/api/content?spaceKey={key}&type=page&limit={limit}&expand=version"
        )
        if err:
            return {"error": err}
        pages = []
        for item in data.get("results", []):
            links = item.get("_links") or {}
            pages.append({
                "id": item.get("id"),
                "title": item.get("title"),
                "url": f"{base_url}/wiki{links.get('webui') or ''}",
            })
        out = {"space": key, "pages": pages, "count": len(pages)}
        # An empty space and a space that does not exist are different facts, and the model
        # will otherwise present both as "I could not find anything".
        if not pages:
            out["note"] = f'Space "{key}" exists but contains no pages this account can see.'
        if len(pages) >= limit:
            out["note_more"] = f"Only the first {limit} pages are shown; there may be more."
        return out

    # ---- GetPages / GetPageMetadata -------------------------------------------------
    def confluence_get_page(page_id: str, include_body: bool = True) -> dict:
        """Read one Confluence page by id: title, space, author, version and text.

        Get the id from confluence_list_pages_in_space or confluence_live_search.

        Args:
            page_id: the page numeric id, e.g. "123456".
            include_body: include the page text (default True). False returns metadata only.

        Returns:
            dict with title, space, url, version, updated, updatedBy and optionally text.
        """
        pid = str(page_id or "").strip()
        if not pid:
            return {"error": "a page_id is required"}
        base_url = _creds()[0]
        # body.view, not body.storage: storage keeps macros as unrendered XML, so a page
        # whose content IS a table or an excerpt macro came back empty and the model
        # reported a populated page as blank.
        expand = "space,version,history.lastUpdated" + (",body.view" if include_body else "")
        data, err = _get(f"{base_url}/wiki/rest/api/content/{pid}?expand={expand}")
        if err:
            return {"error": err}
        version = data.get("version") or {}
        by = version.get("by") or {}
        links = data.get("_links") or {}
        out = {
            "id": data.get("id"),
            "title": data.get("title"),
            "space": ((data.get("space") or {}).get("name")),
            "spaceKey": ((data.get("space") or {}).get("key")),
            "url": f"{base_url}/wiki{links.get('webui') or ''}",
            "version": version.get("number"),
            "updated": version.get("when"),
            "updatedBy": by.get("displayName"),
        }
        if include_body:
            EXCERPT_CHARS = 6000
            text = _strip_html(((data.get("body") or {}).get("view") or {}).get("value") or "")
            out["text"] = text[:EXCERPT_CHARS]
            # Silent truncation lets the model present half a policy page as the whole
            # policy - the fidelity failure this codebase refuses everywhere else.
            if len(text) > EXCERPT_CHARS:
                out["truncated"] = True
                out["note"] = (
                    f"The page is longer than {EXCERPT_CHARS} characters and was cut. "
                    "Open the url for the full text."
                )
        return out

    return [
        confluence_live_search,
        confluence_list_spaces,
        confluence_list_pages_in_space,
        confluence_get_page,
    ]
