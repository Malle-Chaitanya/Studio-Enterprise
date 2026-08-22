"""Jira live tools: search, get-issue, list-projects, current-user, issue-types, sites.

Six tools because that is what real agents call. The Jira MCP server expands to exactly
six operations (GetCurrentUser, ListIssues, ListIssues_Datacenter, ListProjects,
ListResources, ListIssueTypes_V2) and 34 staged agents declare it; three of those six had
no tool until 2026-08-20. Purpose-built rather than
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
  3. `/rest/api/3/search/jql` returns NO `total` - it is cursor-paginated.
     Defaulting to len(issues) made the agent answer "20" to "how many
     tickets do we have?" when the real count was 32,353. The count comes
     from `/search/approximate-count` or it is not reported at all.

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
            max_results: how many issues to return (default 20, max 100).

        Returns:
            dict with `issues` (key, summary, status, assignee, url), `shown` (how many
            are in this response), `totalApproximate` (Jira's approximate count of ALL
            matches - quote this for "how many", and say it is approximate) and `hasMore`.
            `totalApproximate` is absent when Jira could not supply it; in that case say
            the total is unknown rather than counting the rows shown. Or `error`.
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
        out = {"issues": issues, "shown": len(issues)}

        # HOW MANY, answered correctly or not at all.
        #
        # /search/jql is cursor-paginated and returns NO `total` (measured 2026-08-20:
        # total=undefined at every page size, nextPageToken present). The old code did
        # `data.get("total", len(issues))`, so `total` silently became the PAGE SIZE - and
        # the docstring told the model to quote it when asked "how many". An agent asked
        # "how many tickets do we have?" answered 20. The real number was 32,353.
        #
        # /search/approximate-count is Atlassian's own answer to that question, so it is
        # asked separately. If it fails, NO count is reported rather than a wrong one: a
        # missing number makes the model say it cannot count, which is true.
        if data.get("isLast") is False or data.get("nextPageToken"):
            out["hasMore"] = True
        count_body = _json.dumps({"jql": q.split(" ORDER BY ")[0].split(" order by ")[0]}).encode()
        count_req = urllib.request.Request(
            f"{base}/search/approximate-count",
            data=count_body,
            headers={"Authorization": header, "Accept": "application/json", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(count_req, timeout=20) as cresp:
                cdata = _json.loads(cresp.read().decode("utf-8"))
            if isinstance(cdata.get("count"), int):
                out["totalApproximate"] = cdata["count"]
                out["totalNote"] = (
                    "totalApproximate is Jira's own approximate match count for this query - "
                    "quote it for \"how many\", and say it is approximate."
                )
        except Exception:  # noqa: BLE001
            # Deliberately silent: the search itself succeeded and its results are still
            # worth returning. The ABSENCE of a count is the honest signal.
            out["totalNote"] = (
                "The number of matches could not be established, so do not state a total - "
                "only that at least the issues shown match."
            )
        return out

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

    # ---- shared helper ---------------------------------------------------------------
    #
    # NESTED, not module-level: cloudpickle serialises a nested closure BY VALUE and a
    # module-level function BY REFERENCE, so a module-level helper is not shipped in the
    # Reasoning Engine pickle and every tool calling it dies at inference with NameError
    # while working perfectly on the machine that deployed it.

    def _get(path):
        """GET one Jira REST path, returning (parsed, error)."""
        import json as _json
        import urllib.request

        try:
            base = fill(base_url_tpl).rstrip("/")
            header = auth_header(fill)
        except Exception as e:  # noqa: BLE001
            return None, f"auth failed: {e}"
        # base_url_tpl already ends in /rest/api/3 for this connector, so a path starting
        # with / is appended to the SITE root and a bare path to the API root.
        url = f"{base}{path}" if path.startswith("/") else f"{base}/{path}"
        req = urllib.request.Request(url, headers={"Authorization": header, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                return _json.loads(resp.read().decode("utf-8")), None
        except Exception as e:  # noqa: BLE001
            try:
                detail = e.read().decode("utf-8")[:300]  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                detail = str(e)
            status = getattr(e, "code", None)
            if status == 401:
                return None, "Jira rejected the stored email/API token pair."
            if status == 403:
                return None, "The Jira account is not permitted to read this."
            if status == 404:
                return None, f"Jira returned 404 for {url} - the endpoint or id does not exist."
            return None, f"jira request failed ({status}): {detail}"

    # ---- GetCurrentUser -------------------------------------------------------------
    def jira_get_current_user() -> dict:
        """Who is this agent acting as in Jira? Returns the account name and email.

        Use when the user asks about "my" issues so the answer names whose account is
        actually being read - a deployed agent holds ONE identity for everyone who talks
        to it, which is not the person asking.

        Returns:
            dict with accountId, displayName, email, active, timeZone - or `error`.
        """
        data, err = _get("/myself")
        if err:
            return {"error": err}
        return {
            "accountId": data.get("accountId"),
            "displayName": data.get("displayName"),
            "email": data.get("emailAddress"),
            "active": data.get("active"),
            "timeZone": data.get("timeZone"),
            # Said every time, because it is the single most likely misreading of this
            # tool's answer: the migrated agent is not the person in the conversation.
            "note": (
                "This is the shared account the migrated agent uses, not the person asking. "
                "JQL terms like currentUser() resolve to THIS account."
            ),
        }

    # ---- ListIssueTypes_V2 ----------------------------------------------------------
    def jira_list_issue_types(max_results: int = 60) -> dict:
        """List the issue types on this Jira site (Bug, Task, Story, Sub-task, ...).

        Args:
            max_results: cap on how many to return (default 60).

        Returns:
            dict with `issueTypes` (list of {id, name, description, subtask}) and `count`.
        """
        data, err = _get("/issuetype")
        if err:
            return {"error": err}
        try:
            cap = max(1, min(int(max_results or 60), 200))
        except (TypeError, ValueError):
            cap = 60
        rows = data if isinstance(data, list) else data.get("values", [])
        # A large site repeats the same names once per project scheme, which reads to the
        # model as dozens of distinct types. Deduplicate on name and say what was collapsed.
        seen = {}
        for it in rows:
            name = it.get("name")
            if name and name not in seen:
                seen[name] = {
                    "id": it.get("id"),
                    "name": name,
                    "description": (it.get("description") or "")[:160],
                    "subtask": bool(it.get("subtask")),
                }
        types = list(seen.values())[:cap]
        out = {"issueTypes": types, "count": len(types)}
        if len(rows) > len(seen):
            out["note"] = (
                f"{len(rows)} issue-type entries collapsed to {len(seen)} distinct names - "
                "Jira repeats a type once per project scheme."
            )
        return out

    # ---- ListResources --------------------------------------------------------------
    def jira_list_sites() -> dict:
        """Which Atlassian site this agent can reach, and whether it is responding.

        Copilot's "Get list of Resources" enumerated every site an OAuth token could reach.
        A migrated agent authenticates with a stored email + API token against ONE site, and
        Atlassian's accessible-resources endpoint rejects that credential type (401,
        measured 2026-08-20) - so there is exactly one resource to report and no way to
        discover others. Reported honestly rather than omitted, because an agent that used
        this operation to pick between sites needs to know it can no longer do so.

        Returns:
            dict with `sites` (one entry), `count`, and a `note` stating the limitation.
        """
        data, err = _get("/serverInfo")
        if err:
            return {"error": err}
        return {
            "sites": [{
                "url": data.get("baseUrl"),
                "deploymentType": data.get("deploymentType"),
                "version": data.get("version"),
                "reachable": True,
            }],
            "count": 1,
            "note": (
                "The migrated agent is configured for this one Atlassian site. Copilot's "
                "resource list could span several sites; that discovery is not available "
                "with a stored API token, so if the source agent chose between sites, that "
                "choice is now fixed to this one."
            ),
        }

    return [
        jira_search,
        jira_get_issue,
        jira_list_projects,
        jira_get_current_user,
        jira_list_issue_types,
        jira_list_sites,
    ]
