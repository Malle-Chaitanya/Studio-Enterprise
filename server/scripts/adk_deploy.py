#!/usr/bin/env python
"""Deploy one ADK agent as a Vertex AI Reasoning Engine (Agent Runtime).

Called by services/adkDeployer.ts. Reads an ADK spec (JSON), builds an ADK
LlmAgent, deploys it, and prints ONE JSON line on stdout:
    {"reasoningEngine": "projects/.../locations/.../reasoningEngines/..."}   on success
    {"error": "..."}                                                          on failure

Auth: uses GOOGLE_SA_KEY_FILE (or GOOGLE_APPLICATION_CREDENTIALS) — same SA the
migration tool uses. Requires a GCS staging bucket (--staging-bucket or
ADK_STAGING_BUCKET); it is auto-created if missing.

    python adk_deploy.py --project P --location us-central1 \
        --spec '{"name":"...","displayName":"...","instruction":"...","model":"gemini-2.5-flash","tools":["googleSearch"]}' \
        --staging-bucket gs://my-bucket

If spec.groundingDataStores is set (a list of {resourcePath, sourceName} —
sourceName is the REAL human-readable file/site name, not a synthetic id; a
public-website store from adkDeployer.ts createWebsiteGroundingDataStore,
and/or "document"/connector stores for locally-uploaded files or
SharePoint/Dataverse sources), grounding is wired as the agent's ONLY
tool(s), taking priority over `tools`. A single store uses the built-in
VertexAiSearchTool directly. Multiple stores use hand-rolled FunctionTools
instead (see _make_search_tool) — NOT N VertexAiSearchTool instances combined
via bypass_multi_tools_limit, which deploys fine but crashes every query with
"Duplicate function declaration found: discovery_engine_search" (confirmed
live 2026-08-05 — ADK's auto-wrap gives every instance the same hardcoded
function name; see the comment on _make_search_tool for the full writeup and
upstream issue links). Each hand-rolled tool is named/documented after its
real sourceName (see _sanitize_tool_name) — confirmed live 2026-08-06 that
without this, the model cites its own generic tool name
("search_knowledge_source_1") back to the end user instead of a real,
recognizable source name.
"""
import argparse
import json
import os
import re
import sys


def _safe_agent_name(raw: str) -> str:
    """ADK agent names must be valid python identifiers (used as function names when
    the router exposes transfer_to_<name>), so topic titles like "Sign in " cannot be
    passed through unchanged."""
    import re as _re
    name = _re.sub(r"[^A-Za-z0-9_]", "_", str(raw)).strip("_")
    name = _re.sub(r"_+", "_", name) or "topic"
    if name[0].isdigit():
        name = f"t_{name}"
    return name[:60]


def emit(obj):
    # The Node caller parses the LAST stdout line as JSON.
    print(json.dumps(obj), flush=True)


# ---------------------------------------------------------------------------
# Live connector tools (Track B).
#
# Each entry in spec.liveConnectors becomes a real Python function tool that runs
# inside the Reasoning Engine container and calls the third-party API live.
#
# Credentials are fetched from Secret Manager on every call rather than captured
# at deploy time, for two reasons: a rotated token keeps working without a
# redeploy, and nothing secret is ever pickled into the deployment or exposed in
# the agent instruction (where any user could extract it by asking the agent to
# repeat its prompt).
#
# Requires the Reasoning Engine runtime service agent
# (service-<projectNumber>@gcp-sa-aiplatform-re.iam.gserviceaccount.com) to hold
# roles/secretmanager.secretAccessor on the project — without it every tool call
# fails with 403 at inference time even though deployment succeeded.
# ---------------------------------------------------------------------------
def _build_live_connector_tool(conn: dict, project: str):
    """Return a callable ADK function tool for one live connector."""
    kind = (conn.get("kind") or conn.get("id") or "").lower()
    secret_ids = conn.get("secretIds") or {}

    def _secret(field: str) -> str:
        """Read one credential field from Secret Manager (latest version).

        Uses the REST API with google-auth rather than the google-cloud-secret-manager
        client on purpose: installing that client shadows the `google.cloud` namespace
        package in the RE container and breaks VertexAiSearchTool's
        `from google.cloud import discoveryengine_v1beta`, which silently turns every
        answer into an empty string.
        """
        import base64
        import json as _json
        import urllib.request

        import google.auth
        from google.auth.transport.requests import Request as _AuthRequest

        secret_id = secret_ids.get(field)
        if not secret_id:
            raise RuntimeError(f"no secret id configured for field '{field}'")

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(_AuthRequest())
        url = (
            f"https://secretmanager.googleapis.com/v1/projects/{project}"
            f"/secrets/{secret_id}/versions/latest:access"
        )
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {creds.token}"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = _json.loads(resp.read().decode("utf-8"))
        return base64.b64decode(payload["payload"]["data"]).decode("utf-8")

    base_url_tpl = conn.get("baseUrlTemplate") or ""
    auth_header_tpl = conn.get("authHeaderTemplate") or ""
    conn_name = conn.get("name") or kind or "connector"
    auth_kind = conn.get("authKind") or "bearer"
    # The operations the SOURCE agent actually invoked, extracted from Copilot Studio.
    # Telling the model which ones this agent was built around is the difference between
    # a generic REST tool and one that knows what this agent is for.
    # Each entry is {id, description}; plain strings are still accepted so an older
    # spec does not break. The DESCRIPTION is the valuable half — it is what Copilot
    # Studio showed the author for that operation ("This operation returns a list of
    # issues using JQL"), i.e. the source's own statement of what the agent does.
    _ops = []
    for o in (conn.get("operations") or []):
        if isinstance(o, str):
            _ops.append((o, ""))
        elif isinstance(o, dict) and o.get("id"):
            _ops.append((str(o["id"]), str(o.get("description") or "")))
    operations_hint = (
        "\nThe source agent used these operations — prefer them when they fit the request:\n"
        + "".join(f"  - {oid}{': ' + desc if desc else ''}\n" for oid, desc in _ops)
        if _ops
        else ""
    )
    token_url_tpl = conn.get("tokenUrlTemplate") or ""
    scope = conn.get("scope") or ""
    basic_user_field = conn.get("basicUserField") or ""
    basic_secret_field = conn.get("basicSecretField") or ""

    # Minted tokens are cached per container for their stated lifetime. Without this
    # every tool call would perform a fresh OAuth exchange — slow, and enough calls
    # to trip provider rate limits during a normal conversation.
    token_cache: dict = {}

    def _mint_token(fill) -> str:
        """Exchange the customer's durable credentials for an access token.

        Customers can supply client ids, secrets and refresh tokens — all long-lived.
        They cannot supply an access token: those come from this exchange and expire
        in about an hour, so anything pasted by hand would break the same day.
        """
        import json as _json
        import time
        import urllib.parse
        import urllib.request

        cached = token_cache.get("token")
        if cached and token_cache.get("expires_at", 0) > time.time() + 60:
            return cached

        if auth_kind == "google-service-account":
            # Sign a JWT with the service-account key and trade it for a token.
            import google.auth.transport.requests
            from google.oauth2 import service_account

            info = _json.loads(_secret("service_account_json"))
            creds = service_account.Credentials.from_service_account_info(
                info, scopes=[scope or "https://www.googleapis.com/auth/cloud-platform"]
            )
            # Domain-wide delegation, when the customer named a user to impersonate.
            try:
                subject = _secret("impersonate_email")
                if subject:
                    creds = creds.with_subject(subject)
            except Exception:  # noqa: BLE001 — optional field
                pass
            creds.refresh(google.auth.transport.requests.Request())
            token_cache["token"] = creds.token
            token_cache["expires_at"] = time.time() + 3000
            return creds.token

        form = {}
        if auth_kind == "oauth2-client-credentials":
            form = {
                "grant_type": "client_credentials",
                "client_id": _secret("client_id"),
                "client_secret": _secret("client_secret"),
            }
            if scope:
                form["scope"] = fill(scope)
        elif auth_kind == "oauth2-refresh-token":
            form = {
                "grant_type": "refresh_token",
                "refresh_token": _secret("refresh_token"),
                "client_id": _secret("client_id"),
                "client_secret": _secret("client_secret"),
            }
        else:
            raise RuntimeError(f"unsupported authKind for token minting: {auth_kind}")

        url = fill(token_url_tpl)
        req = urllib.request.Request(
            url,
            data=urllib.parse.urlencode(form).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            payload = _json.loads(resp.read().decode("utf-8"))
        token = payload.get("access_token")
        if not token:
            raise RuntimeError(f"token endpoint returned no access_token: {str(payload)[:200]}")
        token_cache["token"] = token
        token_cache["expires_at"] = time.time() + int(payload.get("expires_in") or 3600)
        return token

    def _auth_header(fill) -> str:
        """Build the Authorization header for this connector's auth kind."""
        import base64

        if auth_kind == "basic-userpass":
            # WE do the base64, so the customer supplies an email and a token and
            # never hand-encodes anything. Hand-encoding was error-prone and the
            # mistake only surfaced as a 401 inside a live agent conversation.
            user = basic_user_field
            # A field name that is not a stored credential is a literal, e.g. Freshdesk's
            # "X" password slot or Zendesk's "email/token" suffix form.
            if user and user not in ("X",):
                try:
                    user = _secret(user) if "/" not in user else f"{_secret(user.split('/')[0])}/{user.split('/')[1]}"
                except Exception:  # noqa: BLE001
                    pass
            secret = basic_secret_field
            if secret and secret != "X":
                secret = _secret(secret)
            raw = f"{user}:{secret}"
            return "Basic " + base64.b64encode(raw.encode()).decode()

        if auth_kind in ("oauth2-client-credentials", "oauth2-refresh-token", "google-service-account"):
            return f"Bearer {_mint_token(fill)}"

        # 'bearer' / 'basic-raw': the stored value IS the credential.
        header = fill(auth_header_tpl)

        # A custom connector's template is `{api_key}` — sent verbatim, because Power
        # Platform sends whatever the author typed into an apiKey-in-Authorization
        # security definition. But nobody types a scheme into a field labelled "Private
        # App Token", so the header went out as a naked `pat-na2-...` and HubSpot
        # answered 401 — which reads as a bad token and was a missing word (live
        # 2026-08-13, GetCompanies on the custom HubSpot connector).
        #
        # Only add the scheme when there is demonstrably none: a single token with no
        # space cannot be `<scheme> <credential>`. A value the author DID prefix
        # ("Bearer x", "Basic x", "SSWS x") contains a space and is left untouched, so
        # this never overrides an explicit choice.
        if auth_kind == "bearer" and header and " " not in header.strip():
            header = f"Bearer {header.strip()}"
        return header

    def _fill(tpl: str) -> str:
        """Resolve {placeholders} in a template from the stored credentials."""
        import re as _re
        out = tpl
        for field in set(_re.findall(r"\{(\w+)\}", tpl)):
            out = out.replace(f"{{{field}}}", _secret(field))
        return out

    if kind in ("sharepointonline", "sharepoint", "onedrive"):
        # Purpose-built SharePoint tools, SCOPED to the folder the source agent named.
        #
        # Two reasons not to use the generic REST tool here:
        #   1. Scope. An app credential with Sites.Read.All can reach every site in the
        #      tenant (99 in the test tenant). The source Copilot agent pointed at ONE
        #      folder, so the migrated agent must be confined to that folder — a tool
        #      that cannot express a wider path is a stronger guarantee than an
        #      instruction asking it not to wander.
        #   2. Reading files. Graph returns raw bytes; the model needs text. Extraction
        #      (pdf/docx/xlsx) has to happen in the container.
        # EVERY folder/site the source agent named, not just the first one.
        #
        # A Copilot agent can attach several SharePoint sources ("HR Policies" and
        # "IT Runbooks"); scoping the tools to sources[0] left the second one
        # unreachable while the report still claimed SharePoint was migrated. The
        # union of the named paths is exactly what the source agent could see —
        # widening to a common parent, or to the whole tenant, is not.
        scope_uris = [u for u in (conn.get("scopeUris") or []) if u]
        if not scope_uris and conn.get("scopeUri"):
            scope_uris = [conn["scopeUri"]]

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

        def _resolve_scope(token: str, scope_uri: str = ""):
            """Turn one SharePoint URL into (siteId, folderPath)."""
            import urllib.parse
            if not scope_uri:
                return None, ""
            p = urllib.parse.urlparse(scope_uri)
            host = p.netloc
            parts = [urllib.parse.unquote(x) for x in p.path.split("/") if x]
            # Three shapes appear in real tenants, and they are not interchangeable:
            #   /sites/<name>/<library>/<folders...>          team site
            #   /<library>/<folders...>                       the root site
            #   /personal/<user>/Documents/<folders...>       OneDrive, on <tenant>-my
            # Treating the third like the second resolved to the ROOT of the -my host and
            # then looked for a folder literally named "personal/<user>/..." — a silent
            # wrong scope, since Graph answers for the host either way.
            if parts and parts[0].lower() == "personal" and len(parts) >= 2:
                site_path = f"/personal/{parts[1]}"
                rest = parts[2:]
            elif parts and parts[0].lower() == "sites" and len(parts) >= 2:
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
            if not scope_uris:
                return {"error": "no SharePoint scope configured for this agent"}
            items = []
            errors = []
            for scope_uri in scope_uris:
                try:
                    token = _mint_token(_fill)
                    site_id, folder = _resolve_scope(token, scope_uri)
                    if not site_id:
                        continue
                    path = _scoped_path(folder, subfolder)
                    url = (
                        f"/sites/{site_id}/drive/root:/{path}:/children"
                        if path else f"/sites/{site_id}/drive/root/children"
                    )
                    data = _graph(url, token)
                except Exception as e:  # noqa: BLE001
                    # One unreachable source must not hide the others; report per source.
                    errors.append(f"{scope_uri}: {e}")
                    continue
                for i in data.get("value", []):
                    items.append({
                        "name": i.get("name"),
                        "isFolder": "folder" in i,
                        "size": i.get("size"),
                        "lastModified": i.get("lastModifiedDateTime"),
                        "id": i.get("id"),
                        "source": scope_uri,
                    })
            if not items and errors:
                return {"error": "SharePoint list failed — " + "; ".join(errors)}
            out = {"folders": scope_uris, "subfolder": subfolder, "items": items, "count": len(items)}
            if errors:
                out["partialErrors"] = errors
            return out

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
            if not scope_uris:
                return {"error": "no SharePoint scope configured for this agent"}
            # The model names a file, not which connected folder it lives in, so try each
            # scope in turn. Every attempt still goes through _scoped_path, so a path that
            # escapes a folder is rejected for that folder rather than silently retried
            # against a wider one.
            meta = None
            blob = None
            last_error = ""
            for scope_uri in scope_uris:
                try:
                    token = _mint_token(_fill)
                    site_id, folder = _resolve_scope(token, scope_uri)
                    if not site_id:
                        continue
                    full = _scoped_path(folder, file_path)
                    meta = _graph(f"/sites/{site_id}/drive/root:/{full}", token)
                    size = meta.get("size") or 0
                    if size > MAX_BYTES:
                        return {"error": f"file is {size} bytes, too large to read inline"}
                    blob = _graph(f"/sites/{site_id}/drive/root:/{full}:/content", token, raw=True)
                    break
                except Exception as e:  # noqa: BLE001
                    last_error = f"{e}"
                    meta = None
                    continue
            if blob is None or meta is None:
                return {"error": f"SharePoint read failed: {last_error or 'file not found in any connected folder'}"}

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
                    text = "\n".join(p.text for p in docx.Document(io.BytesIO(blob)).paragraphs)
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

    if kind == "jira":
        # Purpose-built, because the generic REST tool cannot know two things that make
        # the difference between working and not:
        #
        #  1. `/rest/api/3/search` was REMOVED by Atlassian. Calling it returns
        #     410 "The requested API has been removed. Please migrate to
        #     /rest/api/3/search/jql" — which is exactly what a migrated agent hit
        #     live on 2026-08-07, reporting "general search functionality is not
        #     working" to the end user.
        #  2. `/rest/api/3/search/jql` rejects unbounded queries with
        #     400 "Unbounded JQL queries are not allowed here", so a bare
        #     "order by created DESC" fails too. A bounded clause is required.
        #
        # Both were verified against the live site. Leaving this to the model means
        # rediscovering them through failures in front of a customer.
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
                base = _fill(base_url_tpl).rstrip("/")
                auth_header = _auth_header(_fill)
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
            req = urllib.request.Request(url, headers={"Authorization": auth_header, "Accept": "application/json"})
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
                base = _fill(base_url_tpl).rstrip("/")
                auth_header = _auth_header(_fill)
            except Exception as e:  # noqa: BLE001
                return {"error": f"auth failed: {e}"}
            url = f"{base}/issue/{urllib.parse.quote(issue_key)}?fields=summary,status,assignee,description"
            req = urllib.request.Request(url, headers={"Authorization": auth_header, "Accept": "application/json"})
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
                base = _fill(base_url_tpl).rstrip("/")
                auth_header = _auth_header(_fill)
            except Exception as e:  # noqa: BLE001
                return {"error": f"auth failed: {e}"}
            url = f"{base}/project/search?maxResults={max(1, min(int(max_results or 50), 100))}"
            if query:
                url += f"&query={urllib.parse.quote(query)}"
            req = urllib.request.Request(url, headers={"Authorization": auth_header, "Accept": "application/json"})
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

    if kind == "confluence":

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
                base_url = _secret("base_url").rstrip("/")
                email = _secret("email")
                token = _secret("api_token")
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

    # ── Bound operations: the call the SOURCE agent actually made ───────────────
    #
    # The generic tool below asks the model to invent a path. That is the weakest
    # possible reproduction: Copilot pinned `entityName` to one table, and a model free
    # to choose picks any table, or none. When the server sends `boundOperations` we
    # instead build ONE typed function per operation the source agent invoked, with the
    # author's fixed arguments baked in and only the arguments they left open in the
    # signature (see connectors/boundToolSpec.ts).
    #
    # URL, verb and parameters come from the connector's own swagger, captured from the
    # CUSTOMER's environment. Auth reuses `_auth_header` above, so there is exactly one
    # implementation of each credential kind.
    bound_ops = conn.get("boundOperations") or []

    # `{cloudId}` and friends are tenant facts, not model arguments. The server fills
    # what it already knows; the rest are resolved here, once per container.
    context_cache: dict = {}

    def _context(name: str, supplied: dict) -> str:
        if supplied.get(name):
            return supplied[name]
        if name in context_cache:
            return context_cache[name]
        if name == "cloudId":
            # Atlassian identifies a site by an opaque cloud id, derivable from the site
            # URL the customer already gave us — so we never ask an admin for a GUID.
            import json as _json
            import urllib.request

            base = _secret("base_url").rstrip("/")
            req = urllib.request.Request(base + "/_edge/tenant_info")
            with urllib.request.urlopen(req, timeout=20) as resp:
                cloud_id = _json.loads(resp.read().decode("utf-8")).get("cloudId", "")
            context_cache[name] = cloud_id
            return cloud_id
        raise RuntimeError("no value for '" + name + "' - the migrated tool cannot build its URL")

    # A tool result goes straight into the model's context. Copilot's own connector calls
    # were bounded by the maker's page size; ours are bounded by nothing, so a list
    # operation against a real CRM can return megabytes. Unbounded, that either blows the
    # context window or silently costs a fortune per turn, and the failure appears as a
    # confusing model error rather than as "too much data".
    #
    # So: cap it, say so, and tell the model how to narrow. Truncating in silence would let
    # the model present a partial list as the whole answer, which is the fidelity failure
    # this codebase refuses everywhere else.
    RESULT_CHAR_BUDGET = 24000

    def _capped(result: dict, narrowing=None) -> dict:
        import json as _json

        try:
            text = _json.dumps(result.get("body"))
        except Exception:  # noqa: BLE001
            text = str(result.get("body"))
        if len(text) <= RESULT_CHAR_BUDGET:
            return result
        hint = ""
        if narrowing:
            hint = " Narrow the request with: " + ", ".join(narrowing) + "."
        return {
            "status": result.get("status"),
            "truncated": True,
            "note": (
                "The response was " + str(len(text)) + " characters and has been cut to "
                + str(RESULT_CHAR_BUDGET) + ". This is a PARTIAL result - do not describe it "
                "as the complete set." + hint
            ),
            "body": text[:RESULT_CHAR_BUDGET],
        }

    def _make_bound_tool(op: dict):
        """Build one typed ADK function tool for one bound operation."""
        import json as _json
        import re as _re
        import urllib.parse
        import urllib.request

        method = (op.get("method") or "GET").upper()
        url_tpl = op.get("urlTemplate") or ""
        fixed = op.get("fixedArgs") or {}
        model_args = op.get("modelArgs") or []
        ctx_required = op.get("contextRequired") or []
        ctx_values = op.get("contextValues") or {}
        op_id = op.get("operationId") or "operation"

        # Only a legal Python identifier can be in a signature. OData names like `$filter`
        # are not, so they are exposed with the punctuation stripped and mapped back when
        # the request is built — the alternative is losing the ability to filter at all.
        def py_name(n):
            return _re.sub(r"[^0-9a-zA-Z_]", "_", n).strip("_") or "arg"

        seen = set()
        unique_args = []
        for a in model_args:
            pn = py_name(a.get("name") or "")
            if pn in seen:
                continue
            seen.add(pn)
            unique_args.append((pn, a))

        # Which arguments can shrink the next call. Derived from the operation's own
        # parameters so the advice is true for THIS endpoint, not generic prose.
        narrowing = [
            a.get("name")
            for a in model_args
            if a.get("name") in ("limit", "$top", "top", "pageSize", "maxResults", "$filter", "filter", "$select")
        ]

        def _aad_header() -> str:
            """Entra token for a named resource, from the customer's app registration.

            Dataverse is app-only: the resource is the customer's own org URL, which the
            server passes as context rather than asking an admin to paste a URL we already
            hold. The registry's generic client_credentials path cannot be reused here
            because it resolves the scope from a stored `org_url` secret that, by design,
            does not exist for this connector.
            """
            import json as _json
            import time
            import urllib.parse
            import urllib.request

            resource = op.get("aadResource") or ""
            for c in ctx_required:
                resource = resource.replace("{" + c + "}", _context(c, ctx_values))
            resource = resource.rstrip("/")
            cache_key = "aad:" + resource
            cached = token_cache.get(cache_key)
            if cached and cached.get("expires_at", 0) > time.time() + 60:
                return "Bearer " + cached["token"]
            form = {
                "grant_type": "client_credentials",
                "client_id": _secret("client_id"),
                "client_secret": _secret("client_secret"),
                "scope": resource + "/.default",
            }
            url = "https://login.microsoftonline.com/" + _secret("tenant_id") + "/oauth2/v2.0/token"
            req = urllib.request.Request(
                url,
                data=urllib.parse.urlencode(form).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=25) as resp:
                payload = _json.loads(resp.read().decode("utf-8"))
            token = payload.get("access_token")
            if not token:
                raise RuntimeError("no access_token for " + resource)
            token_cache[cache_key] = {"token": token, "expires_at": time.time() + int(payload.get("expires_in") or 3600)}
            return "Bearer " + token

        def _invoke(**kwargs) -> dict:
            try:
                auth_header = _aad_header() if op.get("auth") == "aad-token" else _auth_header(_fill)
            except Exception as e:  # noqa: BLE001
                return {"error": "auth failed (" + str(op.get("auth") or auth_kind) + "): " + str(e)}

            path_params, query, headers = {}, {}, {}
            body_val = None
            for name, meta in fixed.items():
                where = meta.get("in") or "query"
                val = meta.get("value")
                if where == "path":
                    path_params[name] = val
                elif where == "header":
                    headers[name] = str(val)
                elif where == "body":
                    body_val = val
                else:
                    query[name] = val
            for pn, a in unique_args:
                val = kwargs.get(pn)
                if val is None or val == "" or val == 0 or val is False:
                    continue
                where = a.get("in") or "query"
                if where == "path":
                    path_params[a["name"]] = val
                elif where == "header":
                    headers[a["name"]] = str(val)
                elif where == "body":
                    body_val = val
                else:
                    query[a["name"]] = val

            url = url_tpl
            try:
                for c in ctx_required:
                    url = url.replace("{" + c + "}", _context(c, ctx_values))
            except Exception as e:  # noqa: BLE001
                return {"error": str(e)}
            for name, val in path_params.items():
                url = url.replace("{" + name + "}", urllib.parse.quote(str(val), safe=""))
            missing = _re.findall(r"\{(\w+)\}", url)
            if missing:
                return {"error": "missing required value(s) for " + ", ".join(missing)}
            if query:
                url = url + "?" + urllib.parse.urlencode(query)

            req_headers = {"Accept": "application/json"}
            req_headers.update(headers)
            if auth_header:
                req_headers["Authorization"] = auth_header
            data = None
            if body_val is not None and method in ("POST", "PUT", "PATCH"):
                payload = body_val if isinstance(body_val, str) else _json.dumps(body_val)
                data = payload.encode("utf-8")
                req_headers["Content-Type"] = "application/json"
            req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    raw = resp.read().decode("utf-8")
                    try:
                        parsed = _json.loads(raw)
                    except Exception:  # noqa: BLE001
                        return _capped({"status": resp.status, "body": raw}, narrowing)
                    return _capped({"status": resp.status, "body": parsed}, narrowing)
            except Exception as e:  # noqa: BLE001
                # Quote the failure. A vague error invites the model to narrate a
                # plausible answer instead of reporting that it could not look.
                try:
                    detail = e.read().decode("utf-8")[:500]  # type: ignore[attr-defined]
                except Exception:  # noqa: BLE001
                    detail = str(e)
                return {"error": conn_name + " " + op_id + " failed: " + detail}

        # ADK describes a tool to the model from its SIGNATURE and docstring, so the
        # signature has to be real. Generated here rather than **kwargs, which ADK
        # cannot turn into a FunctionDeclaration.
        parts = []
        for pn, a in unique_args:
            t = a.get("type")
            if t == "integer":
                parts.append(pn + ": int = 0")
            elif t == "boolean":
                parts.append(pn + ": bool = False")
            else:
                parts.append(pn + ': str = ""')
        sig = ", ".join(parts)
        call_args = ", ".join(pn + "=" + pn for pn, _ in unique_args)
        fn_name = op.get("toolName") or ("call_" + op_id.lower())
        src = "def " + fn_name + "(" + sig + ") -> dict:\n    return _invoke(" + call_args + ")\n"
        ns = {"_invoke": _invoke}
        exec(src, ns)  # noqa: S102 - generated from our own spec, never from model output
        fn = ns[fn_name]

        arg_doc = ""
        for pn, a in unique_args:
            arg_doc += "    " + pn + ": " + str(a.get("description") or a.get("name") or "")
            arg_doc += " (required)\n" if a.get("required") else "\n"
        pinned = ", ".join(k + "=" + str(v.get("value")) for k, v in fixed.items())
        doc = str(op.get("description") or op_id) + "\n\n"
        doc += "Calls " + conn_name + " (" + op_id + "). Migrated from Microsoft Copilot Studio.\n"
        if pinned:
            doc += "Fixed by the original agent: " + pinned + "\n"
        if arg_doc:
            doc += "\nArgs:\n" + arg_doc
        doc += "\nReturns:\n    dict with `status` and `body`, or `error`.\n"
        fn.__doc__ = doc
        return fn

    if bound_ops:
        built = []
        for op in bound_ops:
            try:
                built.append(_make_bound_tool(op))
            except Exception as e:  # noqa: BLE001
                # One malformed operation must not cost the agent every other tool. If
                # NOTHING can be built we fall through to the generic tool below.
                print("[warn] bound tool build failed for " + str(op.get("operationId")) + ": " + str(e), flush=True)
        if built:
            return built

    # Generic REST connector: base URL + auth header from the registry, resolved
    # from Secret Manager the same way.
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
        import re
        import urllib.request

        try:
            base = _fill(base_url_tpl).rstrip("/")
            auth_header = _auth_header(_fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed ({auth_kind}): {e}"}

        headers = {"Accept": "application/json"}
        if auth_header:
            headers["Authorization"] = auth_header
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

    # Name the tool AFTER ITS CONNECTOR. Every generic connector used to return a
    # function literally called `call_external_api`, so an agent with two of them —
    # Jira and HubSpot, which is a normal pairing — sent Gemini two identical
    # FunctionDeclarations and was rejected with "Duplicate function declaration
    # found: call_external_api". Same class of bug as the DiscoveryEngineSearchTool
    # collision documented above, and it only appears once a SECOND generic connector
    # is configured, so adding a connector broke agents that previously worked.
    #
    # The docstring is per-connector for a second reason: `call_external_api` on "the
    # configured external system" tells the model nothing about WHICH system or what
    # paths are valid, so it had to guess. Naming the product and its base URL is what
    # makes the tool usable.
    safe = re.sub(r"[^a-z0-9]+", "_", (kind or conn_name).lower()).strip("_") or "external"
    call_external_api.__name__ = f"call_{safe}_api"[:56]
    call_external_api.__doc__ = (
        f"Call the {conn_name} REST API on the user's behalf.\n"
        f"\n"
        f"Requests are sent to {base_url_tpl or 'the connector base URL'} with the caller's\n"
        f"credentials already applied — never include tokens in the path.\n"
        f"{operations_hint}"
        f"\n"
        f"Args:\n"
        f"    path: path (and query string) appended to the base URL.\n"
        f"    method: HTTP method, e.g. GET or POST.\n"
        f"    body: JSON request body as a string, for POST/PUT.\n"
        f"\n"
        f"Returns:\n"
        f"    dict with `status` and `body`, or `error`.\n"
    )
    return call_external_api


# ---------------------------------------------------------------------------
# ReasoningEngineAgentWrapper — standalone class, NOT a subclass of AdkApp.
#
# Agentspace sends class_method='query' when calling the RE.  The RE runtime
# (python_file_api_builder.py) builds its "available methods" list from
# AdkApp's hardcoded interface: only [stream_query, async_stream_query,
# streaming_agent_run_with_events] are exposed for any AdkApp subclass,
# regardless of additional methods added.  Subclassing AdkApp and adding
# query() therefore never makes query() callable — it stays outside the
# runtime's discovery scope.
#
# Using a standalone class (object base, not AdkApp) forces the RE runtime
# to fall through to dynamic method introspection on the actual instance,
# which discovers query() along with the standard stream_query variants.
# AdkApp is used internally (composition) to handle the runner/session setup.
# ---------------------------------------------------------------------------
class ReasoningEngineAgentWrapper:
    """Standalone RE wrapper: exposes query() + stream_query for Agentspace.

    Composition over inheritance: internally holds an AdkApp but does NOT
    inherit from it, so the RE runtime's method discovery is not restricted
    to AdkApp's hardcoded interface.  query() delegates to stream_query().
    """

    def __init__(self, agent, enable_tracing=False):
        self._agent = agent
        self._tracing = enable_tracing
        self._app = None  # created lazily in set_up(); excluded from pickle

    def __getstate__(self):
        # Pickle only agent + config — AdkApp holds live runners/clients
        # that don't survive a round-trip through cloudpickle.
        return {"_agent": self._agent, "_tracing": self._tracing}

    def __setstate__(self, state):
        self._agent = state["_agent"]
        self._tracing = state["_tracing"]
        self._app = None

    def set_up(self):
        """Called by the RE runtime on container startup."""
        try:
            from vertexai.preview.reasoning_engines import AdkApp as _Cls
        except ImportError:
            from vertexai.reasoning_engines import AdkApp as _Cls
        self._app = _Cls(agent=self._agent, enable_tracing=self._tracing)
        self._app.set_up()

    def _ensure(self):
        if self._app is None:
            self.set_up()
        return self._app

    def query(self, **kwargs):
        """Agentspace calls this via class_method='query'."""
        return self._ensure().stream_query(**kwargs)

    def stream_query(self, **kwargs):
        return self._ensure().stream_query(**kwargs)

    def async_stream_query(self, **kwargs):
        return self._ensure().async_stream_query(**kwargs)

    def streaming_agent_run_with_events(self, **kwargs):
        return self._ensure().streaming_agent_run_with_events(**kwargs)
# Multiple data stores do NOT use N VertexAiSearchTool instances with
# bypass_multi_tools_limit=True — that was tried and confirmed broken live
# (2026-08-05): ADK auto-wraps each into a DiscoveryEngineSearchTool at QUERY
# time, but that wrapper's declared function name is hardcoded to
# "discovery_engine_search" (discovery_engine_search_tool.py's __init__
# always does `super().__init__(self.discovery_engine_search)`, with no way
# to override the name — confirmed unchanged on google/adk-python@main, not a
# version lag; see open upstream issues #3146 and #3406 acknowledging this
# wrapper path is unfinished). 2+ instances always collide with "Duplicate
# function declaration found: discovery_engine_search", breaking every query
# on the agent.
#
# search_engine_id + data_store_specs (Vertex AI Search's own way to scope ONE
# tool across several stores) was also considered and rejected: per
# google.genai.types' own docstring, data_store_specs is "only considered for
# Engines with multiple data stores" — it requires the stores to already be
# attached to a shared Engine resource, which would mean every migrated
# agent's knowledge becomes visible to every other agent on that Engine, the
# exact per-agent-isolation loss this pipeline is built to avoid (see
# docs/knowledge-sources-migration-playbook.md and the 2026-08-04
# knowledge-parity fix).
#
# So: hand-roll one FunctionTool per data store instead, each wrapping a
# closure that calls discoveryengine_v1beta.SearchServiceClient.search
# directly against ONLY that store's serving config — the same call
# DiscoveryEngineSearchTool._do_search makes internally (mirrored here,
# CHUNKS mode only — this pipeline's stores are all unstructured
# document/file/connector stores, not structured tables, so the
# DOCUMENTS-mode fallback that class also has isn't needed). Each closure's
# __name__ is set explicitly before wrapping, so the FunctionDeclaration ADK
# sends to Gemini is genuinely distinct per store — the collision is
# structurally impossible this way, not just avoided.
def _sanitize_tool_name(source_name, fallback):
    """Turn a real source name ("Slack to Teams- Migration Guide.pdf") into a
    valid Python identifier for the function name Gemini sees and can call.
    Falls back to a generic name only if nothing usable survives sanitizing —
    e.g. a source name that's ALL punctuation/non-ASCII."""
    import re

    slug = re.sub(r"[^a-zA-Z0-9]+", "_", source_name).strip("_").lower()
    slug = re.sub(r"^[0-9]", "_", slug)  # identifiers can't start with a digit
    return f"search_{slug}"[:64] if slug else fallback


def _make_search_tool(data_store_id, tool_name, source_name):
    from google.adk.tools import FunctionTool

    # `serving_config` is a plain string — the ONLY thing this closure
    # captures. The SearchServiceClient must NOT be constructed here and
    # captured by the closure: Agent Engine deployment serializes (pickles)
    # the whole agent, including its tools, to ship it to the cloud, and a
    # live gRPC client (open credentials/channel state) isn't picklable.
    # Confirmed live 2026-08-05: capturing a pre-built client made deploy
    # itself fail with "Failed to serialize agent engine." The client is
    # instead built fresh INSIDE _search on every call — cheap (a local
    # client object, no network round-trip until .search() itself) and
    # avoids serialization entirely, since only serving_config (a string)
    # needs to survive the pickle.
    serving_config = f"{data_store_id}/servingConfigs/default_config"

    def _run_search(discoveryengine, client, query, mode):
        spec_cls = discoveryengine.SearchRequest.ContentSearchSpec
        if mode == "DOCUMENTS":
            content_search_spec = spec_cls(search_result_mode=spec_cls.SearchResultMode.DOCUMENTS)
        else:
            content_search_spec = spec_cls(
                search_result_mode=spec_cls.SearchResultMode.CHUNKS,
                chunk_spec=spec_cls.ChunkSpec(num_previous_chunks=0, num_next_chunks=0),
            )
        request = discoveryengine.SearchRequest(
            serving_config=serving_config,
            query=query,
            content_search_spec=content_search_spec,
        )
        response = client.search(request)
        results = []
        for item in response.results:
            if mode == "DOCUMENTS":
                doc = item.document
                if not doc:
                    continue
                title, uri, content = "", "", ""
                if doc.struct_data:
                    data = dict(doc.struct_data)
                    title = data.pop("title", "")
                    uri = data.pop("uri", data.pop("link", ""))
                    content = json.dumps(data)
                elif doc.derived_struct_data:
                    data = dict(doc.derived_struct_data)
                    title = data.get("title", "")
                    uri = data.get("link", "")
                    snippets = data.get("snippets", [])
                    content = "\n".join(str(s.get("snippet", s)) for s in snippets) if snippets else ""
                results.append({"title": title, "url": uri, "content": content})
            else:
                chunk = item.chunk
                if not chunk:
                    continue
                title, uri = "", ""
                doc_metadata = chunk.document_metadata
                if doc_metadata:
                    title = doc_metadata.title
                    uri = doc_metadata.uri
                results.append({"title": title, "url": uri, "content": chunk.content})
        return results

    def _search(query: str) -> dict:
        f"""Search the "{source_name}" knowledge source for information relevant to the query.

        When citing information from this tool's results in your response, cite it
        as "{source_name}" — never mention this tool/function's own name.

        Args:
          query: The search query.

        Returns:
          A dict with the search status, the source name to cite, and any matching
          results (title, url, content).
        """
        from google.api_core.exceptions import GoogleAPICallError
        from google.cloud import discoveryengine_v1beta as discoveryengine
        import google.auth

        credentials, _ = google.auth.default()
        client = discoveryengine.SearchServiceClient(credentials=credentials)
        try:
            # Auto-detect, same as ADK's own DiscoveryEngineSearchTool: most
            # data stores (uploaded files, SharePoint connector) are
            # unstructured and need CHUNKS mode; structured stores (e.g.
            # Dataverse-snapshot tables) reject CHUNKS and require DOCUMENTS —
            # confirmed live 2026-08-05 against a real SharePoint-connector
            # store: "content_search_spec.search_result_mode must be set to
            # ...DOCUMENTS when the engine contains structured data store."
            try:
                results = _run_search(discoveryengine, client, query, "CHUNKS")
            except GoogleAPICallError as e:
                if "DOCUMENTS" in str(e) and "search_result_mode" in str(e):
                    results = _run_search(discoveryengine, client, query, "DOCUMENTS")
                else:
                    raise
            return {"status": "success", "source": source_name, "results": results}
        except GoogleAPICallError as e:
            return {"status": "error", "source": source_name, "error_message": str(e)}

    _search.__name__ = tool_name
    # The docstring IS the tool description Gemini uses to choose between tools, so it
    # must name THIS source. A shared, generic description makes every knowledge tool
    # look identical and the choice arbitrary.
    # `source_name`, not `label` — the parameter was renamed and this reference was left
    # behind, so every knowledge tool raised `NameError: name 'label' is not defined`. The
    # wiring builds ALL tools in one pass, so one bad knowledge tool took the connector and
    # MCP tools down with it: the deploy fell back to low-code create and produced an agent
    # with NO tools that still reported deployed=true verified=true (live 2026-08-13, "AA").
    if source_name:
        _search.__doc__ = (
            f'Search the "{source_name}" knowledge source for information relevant to the query.\n'
            f"\n"
            f'Use this when the question could be answered by "{source_name}". Prefer the source whose\n'
            f"subject matches the question; if unsure which applies, search more than one.\n"
            f"\n"
            f"Args:\n"
            f"  query: The search query.\n"
            f"\n"
            f"Returns:\n"
            f"  A dict with the search status and any matching results (title, url, content).\n"
        )
    return FunctionTool(_search)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True)
    ap.add_argument("--location", default="us-central1")
    ap.add_argument("--spec", help="ADK spec as JSON (inline)")
    ap.add_argument("--spec-file", help="path to a file containing the ADK spec JSON")
    ap.add_argument("--staging-bucket", default=os.environ.get("ADK_STAGING_BUCKET"))
    args = ap.parse_args()

    try:
        raw = open(args.spec_file, encoding="utf-8").read() if args.spec_file else args.spec
        if not raw:
            emit({"error": "provide --spec or --spec-file"}); return
        spec = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        emit({"error": f"bad spec json: {e}"}); return

    # Auth: point ADC at the SA key the tool already uses.
    key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") or os.environ.get("GOOGLE_SA_KEY_FILE")
    if key and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = key

    try:
        import vertexai
        from vertexai import agent_engines
        from google.adk.agents import Agent
    except Exception as e:  # noqa: BLE001
        emit({"error": f"SDK import failed (pip install 'google-cloud-aiplatform[agent_engines]' google-adk): {e}"}); return

    # Ensure a staging bucket exists (Agent Engine needs one to package code).
    bucket = args.staging_bucket
    if not bucket:
        bucket = f"gs://{args.project}-adk-staging"
    try:
        from google.cloud import storage
        client = storage.Client(project=args.project)
        name = bucket.replace("gs://", "").split("/")[0]
        if not client.lookup_bucket(name):
            client.create_bucket(name, location=args.location)
    except Exception as e:  # noqa: BLE001
        emit({"error": f"staging bucket setup failed ({bucket}): {e}"}); return

    # Build tools from the spec. A single data store uses the built-in
    # VertexAiSearchTool directly — proven working, no issues. Multiple data
    # stores use _make_search_tool (module-level, see its comment above for
    # the full reasoning) instead of combining VertexAiSearchTool instances.
    tools = []
    # Reported back to the server so a dropped capability becomes a fidelity note
    # instead of vanishing — a silent drop is the failure mode this project keeps hitting.
    dropped_google_search = False
    grounding_data_stores = spec.get("groundingDataStores") or []
    grounding_engine_configs = spec.get("groundingEngineServingConfigs") or []
    live_connectors = spec.get("liveConnectors") or []
    try:
        # grounding_engine_configs is intentionally unhandled: nothing in the app
        # ever sets spec.groundingEngineServingConfigs (verified 2026-08-06), and
        # search_engine_id would scope the tool across a shared Engine's stores,
        # leaking one agent's knowledge to every other agent on that Engine.
        if len(grounding_data_stores) == 1:
            from google.adk.tools import VertexAiSearchTool
            # bypass_multi_tools_limit is required whenever this agent ALSO has live
            # connector tools: without it ADK refuses to put VertexAiSearchTool
            # alongside any other tool. One search tool wrapped as
            # DiscoveryEngineSearchTool is fine — the duplicate-function-name
            # collision only happens with 2+ of them, which is why the multi-store
            # branch below hand-rolls distinct tools instead. Live-verified in this
            # combination (indexed grounding + confluence_live_search) 2026-08-06.
            tools.append(VertexAiSearchTool(
                data_store_id=grounding_data_stores[0]["resourcePath"],
                bypass_multi_tools_limit=bool(live_connectors),
            ))
        elif len(grounding_data_stores) > 1:
            seen_names = set()
            for i, entry in enumerate(grounding_data_stores):
                fallback = f"search_knowledge_source_{i + 1}"
                tool_name = _sanitize_tool_name(entry.get("sourceName") or "", fallback)
                if tool_name in seen_names:  # two sources sanitizing to the same slug — keep names distinct (see 2026-08-05 duplicate-name incident)
                    tool_name = fallback
                seen_names.add(tool_name)
                tools.append(_make_search_tool(entry["resourcePath"], tool_name, entry.get("sourceName") or fallback))
        elif "googleSearch" in (spec.get("tools") or []):
            # ONLY when google_search can stand alone. Gemini rejects a built-in search
            # tool mixed with function tools ("Multiple tools are supported only when
            # they are all search tools"), and sub-agents add transfer functions of
            # their own. Adding it anyway produced an agent that deployed cleanly and
            # then 400'd on every single message — live 2026-08-07, Confluence_agent,
            # which reached this branch precisely BECAUSE its knowledge migration had
            # failed and left it with zero stores.
            if live_connectors or spec.get("subAgents"):
                dropped_google_search = True
            else:
                from google.adk.tools import google_search
                tools.append(google_search)

        # Live action connectors (Track B). A real callable tool, NOT instruction
        # text: an LLM told "call https://... with Bearer x" has no way to make an
        # HTTP request, so the instruction-block approach could only ever produce a
        # narrated curl command or a hallucinated response. A function tool actually
        # executes in the Reasoning Engine container.
        #
        # Credentials are read from Secret Manager AT CALL TIME inside the container,
        # never embedded in the agent instruction or pickled into the deployment —
        # anything placed in the instruction is retrievable by any end user who asks
        # the agent to repeat its prompt.
        # Function names must be unique across the WHOLE agent, so uniqueness is enforced
        # here — once, over every tool — rather than inside each builder.
        #
        # Two connectors of the same family collide otherwise: shared_sharepointonline and
        # shared_onedrive both take the SharePoint path, which returns hardcoded
        # `sharepoint_list_files` / `sharepoint_read_file`, so wiring both produced
        # "Duplicate function declaration found: sharepoint_list_files" and the agent
        # 400'd on every message (live 2026-08-07). The generic connectors were fixed
        # earlier the same day by naming them per connector; doing it per builder just
        # moves the problem to whichever builder is next.
        used_tool_names = {t.__name__ for t in tools if hasattr(t, "__name__")}
        for conn in live_connectors:
            built = _build_live_connector_tool(conn, args.project)
            # SharePoint contributes two tools (list + read); others contribute one.
            for fn in (built if isinstance(built, (list, tuple)) else [built]):
                original = getattr(fn, "__name__", "tool")
                if original in used_tool_names:
                    kind_hint = re.sub(r"[^a-z0-9]+", "_", str(conn.get("kind") or conn.get("id") or "")).strip("_")
                    candidate = f"{original}_{kind_hint}" if kind_hint else f"{original}_2"
                    i = 2
                    while candidate in used_tool_names:
                        candidate = f"{original}_{kind_hint}_{i}" if kind_hint else f"{original}_{i}"
                        i += 1
                    try:
                        fn.__name__ = candidate[:60]
                    except (AttributeError, TypeError):
                        # A tool object that is not a plain function cannot be renamed;
                        # keep it rather than drop a capability, and let the platform
                        # complain loudly instead of failing silently here.
                        pass
                used_tool_names.add(getattr(fn, "__name__", original))
                tools.append(fn)
    except Exception as e:  # noqa: BLE001
        emit({"error": f"tool wiring failed: {e}"}); return

    # ── Sub-agents (migrated Copilot topics) ─────────────────────────────────
    # Copilot topics are self-contained conversation domains, which is exactly what an
    # ADK sub-agent is: its own name, description and instruction, routed to by the
    # root agent when the user's request matches.
    #
    # They live INSIDE this one deployment. Deploying each topic as its own Reasoning
    # Engine would multiply cost and burn the per-day agent-creation quota (~7) on a
    # single migrated agent; as sub_agents they cost one engine and one registration
    # no matter how many topics the source agent had.
    #
    # `description` is what the root model routes on, so it must say WHEN to use the
    # sub-agent — a description that only restates the name gives the router nothing.
    # ── Callback: make tool use observable ──────────────────────────────────────
    #
    # after_tool_callback fires with the tool's real result, inside the container. That
    # is the only place a tool call can be observed for what it was: verification has
    # been scraping the chat transcript for function_response blocks, which cannot tell
    # WHICH connector answered when an agent has five of them — so an agent where one
    # tool worked and four were broken verified as healthy.
    #
    # The record is written into session state rather than returned, so it travels with
    # the conversation and a verifier can ask what was actually called.
    def _record_tool_call(tool, args, tool_context, tool_response):  # noqa: ANN001
        try:
            state = tool_context.state
            # Bounded: a long conversation must not grow session state without limit,
            # and only recent calls are ever inspected.
            calls = list(state.get("_tool_calls") or [])[-49:]
            failed = isinstance(tool_response, dict) and bool(tool_response.get("error"))
            calls.append({"tool": getattr(tool, "name", str(tool)), "ok": not failed})
            state["_tool_calls"] = calls
        except Exception:  # noqa: BLE001
            # Observability must never break the answer it is observing.
            pass
        return None

    sub_agent_specs = spec.get("subAgents") or []
    sub_agents = []
    for sa in sub_agent_specs:
        sa_kwargs = dict(
            name=_safe_agent_name(sa.get("id") or sa.get("name") or "topic"),
            model=sa.get("model") or spec.get("model", "gemini-2.5-flash"),
            description=sa.get("description") or f"Handles {sa.get('displayName') or sa.get('id')} requests.",
            instruction=sa.get("instruction") or "",
            # Sub-agents inherit nothing implicitly: give them the same tools as the
            # root so a topic that needs SharePoint or a connector can still act.
            tools=tools if sa.get("inheritTools", True) else [],
        )
        try:
            # Same tool-call record as the root. Once the root transfers to a topic, the
            # topic is what calls the tools — without this, every tool call made inside a
            # topic is invisible and the agent looks like it never used its connectors.
            sub_agents.append(Agent(**sa_kwargs, after_tool_callback=_record_tool_call))
        except TypeError:
            sub_agents.append(Agent(**sa_kwargs))
        except Exception as e:  # noqa: BLE001
            emit({"error": f"sub-agent build failed for {sa.get('id')}: {e}"}); return

    # Rules that must hold for the root AND every topic sub-agent. Built server-side
    # (adkDeployer.globalAnswerContract) so the wording lives in one place; ADK's
    # global_instruction is what makes it reach sub-agents, which the root's own
    # instruction never did — a question routed to a topic silently escaped the rules.
    naming_rule = spec.get("globalInstruction") or (
        "Tool and data-store names are internal implementation details. Never list, quote or "
        "describe them to the user. Describe what you can DO and which systems you can reach, "
        "using their product names (SharePoint, Jira, Confluence), never a function name."
    )

    try:
        root_agent = Agent(
            name=spec.get("name", "migrated_agent"),
            model=spec.get("model", "gemini-2.5-flash"),
            description=spec.get("description", ""),
            instruction=spec.get("instruction", "") or "You are a helpful assistant.",
            tools=tools,
            global_instruction=naming_rule,
            after_tool_callback=_record_tool_call,
            **({"sub_agents": sub_agents} if sub_agents else {}),
        )
    except TypeError:
        # Older google-adk builds do not accept global_instruction/after_tool_callback on
        # Agent. Deploying without them is strictly better than failing the migration —
        # the agent still works, it is only less observable — but say so, because a
        # silently less-verifiable agent is exactly what this project keeps being bitten by.
        emit({"warn": "adk build does not support global_instruction/after_tool_callback; deploying without them"})
        root_agent = Agent(
            name=spec.get("name", "migrated_agent"),
            model=spec.get("model", "gemini-2.5-flash"),
            description=spec.get("description", ""),
            instruction=(spec.get("instruction", "") or "You are a helpful assistant.") + "\n\n" + naming_rule,
            tools=tools,
            **({"sub_agents": sub_agents} if sub_agents else {}),
        )
    except Exception as e:  # noqa: BLE001
        emit({"error": f"agent build failed: {e}"}); return

    # bypass_multi_tools_limit=True (set above whenever grounding data stores are
    # present) makes ADK wrap VertexAiSearchTool as a DiscoveryEngineSearchTool
    # at QUERY time (not deploy/construction time — confirmed live: deploy
    # succeeds either way, but every query then fails at import), and that
    # class does `from google.cloud import discoveryengine_v1beta` — a module
    # `google-cloud-aiplatform[agent_engines,adk]`/`google-adk` do NOT pull in.
    # Without this, the DEPLOYED reasoning engine has no way to install it —
    # confirmed live 2026-08-05: a real 2-knowledge-source agent deployed fine,
    # then every single query (including one needing no tool at all) failed
    # with "ImportError: cannot import name 'discoveryengine_v1beta'".
    requirements = ["google-cloud-aiplatform[agent_engines,adk]", "google-adk"]
    if grounding_data_stores:
        requirements.append("google-cloud-discoveryengine")
    # Document text extraction for SharePoint/OneDrive read tools. Added only when such
    # a connector is present, to keep the container minimal — and NONE of these are in
    # the `google.*` namespace, which is the namespace that previously got shadowed and
    # broke VertexAiSearchTool's imports at inference time.
    if any((c.get("kind") or "").lower() in ("sharepointonline", "sharepoint", "onedrive")
           for c in live_connectors):
        requirements += ["pypdf", "python-docx", "openpyxl"]

    try:
        # Deploy a plain AdkApp, NOT ReasoningEngineAgentWrapper.
        #
        # The wrapper existed only to expose query(), on the belief that Agentspace
        # calls class_method='query'. It does not. Verified live 2026-08-06 against
        # this project: agents that work in the Gemini Enterprise UI all report
        # spec.agentFramework='google-adk' and expose create_session /
        # stream_query / streaming_agent_run_with_events and NO query at all, while
        # the wrapper's deployments report agentFramework='custom' exposing
        # query/stream_query/async_stream_query and NO session methods. The UI calls
        # the ADK session contract, so a wrapper deployment fails there with
        # "Reasoning Engine Execution failed ... FAILED_PRECONDITION" even though a
        # direct stream_query(user_id=...) call to it succeeds.
        #
        # The old 400s that motivated the wrapper were a client-side mistake, not a
        # platform bug: class_method='query' does not exist on ADK deployments, and
        # stream_query requires user_id. See services/adkAgentChat.ts for the
        # invocation contract this deployment shape expects.
        try:
            from vertexai.preview.reasoning_engines import AdkApp
        except ImportError:
            from vertexai.reasoning_engines import AdkApp
        agent_engine = AdkApp(agent=root_agent, enable_tracing=False)
        vertexai.init(project=args.project, location=args.location, staging_bucket=bucket)
        remote = agent_engines.create(
            agent_engine=agent_engine,
            display_name=spec.get("displayName", spec.get("name", "Migrated Agent")),
            requirements=requirements,
        )
        emit({
            "reasoningEngine": remote.resource_name,
            "droppedGoogleSearch": dropped_google_search,
        })
    except Exception as e:  # noqa: BLE001
        emit({"error": f"deploy failed: {e}"})


if __name__ == "__main__":
    main()
