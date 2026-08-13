"""Jira live tools: search, get-issue, list-projects. Purpose-built rather than
the generic REST fallback because the generic tool cannot know two things that
make the difference between working and not:

  1. `/rest/api/3/search` was REMOVED by Atlassian. Calling it returns
     410 "The requested API has been removed. Please migrate to
     /rest/api/3/search/jql" — which is exactly what a migrated agent hit
     live on 2026-08-07, reporting "general search functionality is not
     working" to the end user.
  2. `/rest/api/3/search/jql` rejects unbounded queries with
     400 "Unbounded JQL queries are not allowed here", so a bare
     "order by created DESC" fails too. A bounded clause is required.

Both were verified against the live site. Leaving this to the model means
rediscovering them through failures in front of a customer.

See connector_tools/confluence.py's module docstring for the shared
build_tools contract every connector module in this package follows.
"""


def build_tools(conn, secret, mint_token, auth_header, fill):
    base_url_tpl = conn.get("baseUrlTemplate") or ""

    def jira_search(jql: str = "", max_results: int = 20) -> dict:
        """Search Jira issues with JQL and return key, summary, status and assignee.

        Args:
            jql: A JQL query, e.g. 'project = ENG ORDER BY created DESC' or
                'text ~ "login bug" ORDER BY updated DESC'.
                Jira rejects queries with no restriction at all, so if the user did
                not name a project or a timeframe, DO NOT refuse and DO NOT ask —
                pass 'created >= -365d ORDER BY created DESC' and report what comes
                back, saying which window you used. Leaving jql empty does this for
                you. Use jira_list_projects first when the user names a project by
                its display name rather than its key.
            max_results: how many issues to return (default 20, max 100). The
                response also carries `total`, which is the full match count and is
                what to quote when asked "how many".

        Returns:
            dict with `issues` (key, summary, status, assignee, url) and `total`,
            or `error`.
        """
        import json as _json
        import urllib.parse
        import urllib.request

        try:
            base = fill(base_url_tpl).rstrip("/")
            header = auth_header(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}

        # The base template already ends in /rest/api/3 for this connector.
        #
        # The default MUST be bounded. Jira rejects "ORDER BY created DESC" on its own
        # with 400 "Unbounded JQL queries are not allowed here", so a question that
        # produced no explicit JQL — "how many tickets do we have?" — failed on the
        # very call it was meant to answer (verified live 2026-08-07). A date window
        # is the least surprising restriction: it returns recent work rather than
        # silently narrowing to one project.
        q = (jql or "").strip() or "created >= -365d ORDER BY created DESC"
        url = (
            f"{base}/search/jql?jql={urllib.parse.quote(q)}"
            f"&maxResults={max(1, min(int(max_results or 20), 100))}"
            f"&fields=summary,status,assignee"
        )
        req = urllib.request.Request(url, headers={"Authorization": header, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = _json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:300]  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                detail = str(e)
            return {"error": f"Jira search failed: {detail}"}

        site = base.split("/rest/")[0]
        issues = []
        for it in (data.get("issues") or []):
            f = it.get("fields") or {}
            issues.append({
                "key": it.get("key"),
                "summary": f.get("summary"),
                "status": ((f.get("status") or {}).get("name")),
                "assignee": ((f.get("assignee") or {}).get("displayName")),
                "url": f"{site}/browse/{it.get('key')}",
            })
        return {"issues": issues, "total": data.get("total", len(issues))}

    def jira_get_issue(issue_key: str) -> dict:
        """Fetch ONE Jira issue by its exact key, e.g. 'HCL-123'.

        Args:
            issue_key: the issue key.

        Returns:
            dict with key, summary, status, assignee, description text and url,
            or `error`.
        """
        import json as _json
        import urllib.parse
        import urllib.request

        try:
            base = fill(base_url_tpl).rstrip("/")
            header = auth_header(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        url = f"{base}/issue/{urllib.parse.quote(issue_key)}?fields=summary,status,assignee,description"
        req = urllib.request.Request(url, headers={"Authorization": header, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                it = _json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:300]  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                detail = str(e)
            return {"error": f"Jira issue fetch failed: {detail}"}
        f = it.get("fields") or {}
        site = base.split("/rest/")[0]
        return {
            "key": it.get("key"),
            "summary": f.get("summary"),
            "status": ((f.get("status") or {}).get("name")),
            "assignee": ((f.get("assignee") or {}).get("displayName")),
            "url": f"{site}/browse/{it.get('key')}",
        }

    def jira_list_projects(query: str = "", max_results: int = 50) -> dict:
        """List the Jira projects available, optionally filtered by name or key.

        Use this to find a project's KEY before searching its issues — jira_search
        needs a key like 'ENG', not a display name like 'Engineering'.

        Args:
            query: optional text to filter projects by name or key.
            max_results: how many to return (default 50).

        Returns:
            dict with `projects` (key, name) and `total`, or `error`.
        """
        import json as _json
        import urllib.parse
        import urllib.request

        try:
            base = fill(base_url_tpl).rstrip("/")
            header = auth_header(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        url = f"{base}/project/search?maxResults={max(1, min(int(max_results or 50), 100))}"
        if query:
            url += f"&query={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={"Authorization": header, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = _json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:300]  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                detail = str(e)
            return {"error": f"Jira project list failed: {detail}"}
        projects = [{"key": p.get("key"), "name": p.get("name")} for p in (data.get("values") or [])]
        return {"projects": projects, "total": data.get("total", len(projects))}

    return [jira_search, jira_get_issue, jira_list_projects]
