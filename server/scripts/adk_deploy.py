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
import importlib.metadata
import json
import os
import re
import sys


def _pinned(pkg: str, extras: str = "") -> str:
    """Pin a requirement to the EXACT version already imported in this process.

    root_agent (below) is a pydantic-based google-adk `Agent` tree that gets pickled
    here and unpickled inside the freshly-built container. An unpinned "google-adk"
    requirement lets the container install whatever is newest at deploy time — a
    different version than the one that just built root_agent. Confirmed live
    2026-08-16: local build used google-adk 2.5.0 (no `_resolved_model` private attr
    on LlmAgent); the container installed 2.7.0, which added one. Pydantic's
    `__setstate__` restores the OLD instance's `__pydantic_private__` verbatim onto
    the NEW class, so the container's LlmAgent ends up with `__pydantic_private__ is
    None` even though its class declares `_resolved_model` — and the very first
    `hasattr(agent, 'canonical_model')` check ADK does on every turn raises
    `TypeError: 'NoneType' object is not subscriptable` (hasattr only swallows
    AttributeError, so this escapes and kills the turn, including ones needing no
    tool at all). Pinning to what this same process already imported guarantees the
    container installs the identical class shapes that were just pickled.
    """
    try:
        version = importlib.metadata.version(pkg)
    except importlib.metadata.PackageNotFoundError:
        # Should not happen — this script already imported the package by this point —
        # but deploying unpinned is strictly better than crashing the whole migration.
        return f"{pkg}[{extras}]" if extras else pkg
    suffix = f"[{extras}]" if extras else ""
    return f"{pkg}{suffix}=={version}"


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
    """Return a callable ADK function tool (or list of tools) for one live
    connector. Dispatches to connector_tools/<kind>.py — each module owns its own
    tool functions; this function only builds the shared credential/auth
    helpers (_secret, _mint_token, _auth_header, _fill) every connector kind
    needs, and passes them in explicitly.

    Was previously one ~1150-line function with every connector's tool code
    inline (SharePoint, Google Drive, Confluence, generic REST all in one
    dispatch-by-kind block) — split 2026-08-11 so a change to one connector
    can't accidentally break another, and each is easy to find on its own.
    """
    # Make the sibling connector_tools/ package importable regardless of CWD —
    # both locally (server/scripts/) and once bundled into the deployed
    # container, where extra_packages=["scripts/connector_tools"] ships it as
    # a sibling of this file (see agent_engines.create call below). Named
    # "connector_tools", not "connectors", to not collide with the unrelated
    # server/src/connectors/registry.ts (TS credential/registry definitions,
    # a different layer entirely) — same name for two different things is
    # exactly what made this confusing to grep before the split.
    _connectors_parent = os.path.dirname(os.path.abspath(__file__))
    if _connectors_parent not in sys.path:
        sys.path.insert(0, _connectors_parent)

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
        from connector_tools.sharepoint import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    if kind == "googledrive":
        from connector_tools.google_drive import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    # Cross-vendor: a Copilot agent that read Outlook mail migrates to one that reads Gmail.
    # Requires scope=gmail.readonly and an `impersonate_email` secret — a mailbox belongs to
    # a person, so DWD needs a subject. See connector_tools/gmail.py for the fidelity
    # divergences (folders vs labels, flags vs stars) this mapping cannot avoid.
    if kind == "gmail":
        from connector_tools.gmail import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    # Mail that STAYS in Microsoft: the agent moves to Gemini, Graph still serves its mail.
    # Requires app-only ms_graph credentials plus Mail.ReadWrite / Mail.Send APPLICATION
    # permissions with admin consent.
    if kind == "outlook":
        from connector_tools.outlook import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    # CROSS-VENDOR, second of two: Copilot's Teams connector -> Google Chat. Chat is FLAT,
    # so the Team -> Channel hierarchy has no equivalent; see connector_tools/chat.py.
    # Identity is either a DWD-impersonated user or the service account acting as a
    # registered Chat app — the same code serves both.
    if kind in ("googlechat", "chat"):
        from connector_tools.chat import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    # Teams messaging that STAYS in Microsoft. Nothing is translated, so the hierarchy and
    # threading survive. Reading channel/chat message CONTENT app-only is additionally gated
    # by Microsoft's protected-APIs programme, which no code change here can satisfy.
    if kind == "teams":
        from connector_tools.teams import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)


    if kind == "jira":
        from connector_tools.jira import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    if kind == "confluence":
        from connector_tools.confluence import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    # FOUR connector ids, one module. Power Platform ships HubSpot as several separate
    # connectors (the Microsoft one plus three Independent Publisher ones) and agents in
    # the field use the Independent Publisher names — but they are all the same REST API
    # behind the same private app token, so they share a credential group and a tool set.
    # Matching only "hubspot" would miss every id a real agent actually declares.
    if kind.startswith("hubspot"):
        from connector_tools.hubspot import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    # Generic REST connector fallback: bound per-operation tools when the server
    # captured the source agent's actual swagger operations, else a single generic
    # call_external_api tool. See connector_tools/generic_rest.py.
    from connector_tools.generic_rest import build_tools as _build
    return _build(conn, _secret, _mint_token, _auth_header, _fill)


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
    # PER-DEPLOY staging directory. Without it the SDK defaults gcs_dir_name to the
    # literal "agent_engine", so EVERY deploy in a project writes the pickled agent to
    # gs://<bucket>/agent_engine/agent_engine.pkl. Two deploys running at once therefore
    # overwrite each other and both containers get built from whichever package landed
    # last. Confirmed live 2026-08-21: "Hubspot agentt" and "Email Manager" deployed 18s
    # apart, both engines created in the SAME second, and both came up with Email
    # Manager's 16 Outlook tools — the HubSpot agent had none of its own. The server
    # always passes a unique value; the default here only keeps a hand-run working.
    ap.add_argument("--gcs-dir", default=None)
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
    # PIN google-adk TO THE VERSION THAT PICKLED THIS AGENT. Correctness, not hygiene.
    #
    # Agent Engine ships the agent as a PICKLE and rebuilds it inside a container it
    # provisions from this list. Unpinned, that container resolved `google-adk` to whatever
    # PyPI had that day, so an object pickled by our 2.6.2 (or 2.5.0 — confirmed on both,
    # 2026-08-16 and 2026-08-19) was unpickled by a newer ADK. Pydantic private attributes
    # did not survive the mismatch:
    #
    #   File "google/adk/agents/llm_agent.py", line 630, in canonical_model
    #     resolved = self._resolved_model          # <- absent from the older ADK entirely
    #   File "pydantic/main.py", line 1024, in __getattr__
    #     return self.__pydantic_private__[item]
    #   TypeError: 'NoneType' object is not subscriptable
    #
    # EVERY query failed while deploy reported success, the agent registered ENABLED, and
    # the same agent had verified clean days earlier. The break arrived with no change on
    # our side and nothing local reproduces it. See _pinned() above for the pin mechanism.
    #
    # ONLY google-adk is pinned, and that limit is load-bearing. Pinning google-cloud-aiplatform
    # alongside it made the RE build FAIL outright (live 2026-08-19, same agent), because the
    # versions our environment runs are mutually unsatisfiable in a single pip resolve:
    #
    #   google-adk 2.6.2               requires google-genai >=2.9,<3
    #   google-cloud-aiplatform 1.93.0 requires google-genai <2.0.0
    #
    # The Dockerfile only gets away with it by installing them in TWO sequential passes and
    # letting adk upgrade google-genai past aiplatform's declared ceiling. A requirements
    # list has no such escape hatch, so pinning aiplatform alongside adk guarantees
    # ResolutionImpossible and a fallback to the low-code path. Pin the library that owns
    # the pickle; let pip resolve a self-consistent set around it.
    requirements = ["google-cloud-aiplatform[agent_engines,adk]", _pinned("google-adk")]
    emit({"log": f"pinning deploy container to {requirements}"})
    if grounding_data_stores:
        requirements.append(_pinned("google-cloud-discoveryengine"))
    # Document text extraction for SharePoint/OneDrive/Google Drive read tools. Added
    # only when such a connector is present, to keep the container minimal — and NONE
    # of these are in the `google.*` namespace, which is the namespace that previously
    # got shadowed and broke VertexAiSearchTool's imports at inference time.
    #
    # 'googledrive' added 2026-08-11 after live confirmation: google_drive_read_file
    # uses the exact same pypdf/docx/openpyxl imports as the SharePoint tool, but this
    # condition never learned about the new kind — every .xlsx/.docx read on a
    # Drive-only agent failed with "No module named 'openpyxl'"/"'docx'" even though
    # the tool code itself was correct.
    if any((c.get("kind") or "").lower() in ("sharepointonline", "sharepoint", "onedrive", "googledrive")
           for c in live_connectors):
        requirements += ["pypdf", "python-docx", "openpyxl"]
    emit({"info": "reasoning engine requirements", "requirements": requirements})

    # Ship the connector_tools/ package alongside this script whenever a live
    # connector tool is configured — _build_live_connector_tool (above) imports
    # from it at container runtime (`from connector_tools.google_drive import
    # build_tools`, etc.). extra_packages accepts individual files or whole
    # directories (confirmed via the installed SDK's own docstring, 2026-08-11);
    # a directory here ships with its structure intact, so the package-relative
    # import resolves inside the deployed container the same way it does when
    # this script runs locally.
    extra_packages = []
    if live_connectors:
        extra_packages.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "connector_tools"))

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
        # gcs_dir_name is what isolates one deploy's package from another's — see --gcs-dir.
        create_kwargs = {
            "agent_engine": agent_engine,
            "display_name": spec.get("displayName", spec.get("name", "Migrated Agent")),
            "requirements": requirements,
            "extra_packages": extra_packages or None,
        }
        if args.gcs_dir:
            create_kwargs["gcs_dir_name"] = args.gcs_dir
        remote = agent_engines.create(**create_kwargs)
        # The tool names ACTUALLY built, reported back so verification can compare against
        # ground truth instead of guessing.
        #
        # The server used to hand verification the names of the *bound* operations it had
        # planned. For any connector with a hand-written module those names are discarded
        # here (the module returns its own tools), so verification demanded tools that were
        # never going to exist and failed a working agent. Filtering them out on the server
        # then left the list EMPTY, which skipped the tool check altogether - a vacuous pass,
        # which is worse than a wrong failure. Only this process knows what was really wired,
        # so it is the only honest source for the comparison.
        built_tool_names = []
        for _t in tools:
            _n = getattr(_t, "__name__", None) or getattr(_t, "name", None)
            if _n:
                built_tool_names.append(str(_n))
        emit({
            "reasoningEngine": remote.resource_name,
            "droppedGoogleSearch": dropped_google_search,
            "toolNames": built_tool_names,
        })
    except Exception as e:  # noqa: BLE001
        emit({"error": f"deploy failed: {e}"})


if __name__ == "__main__":
    main()
