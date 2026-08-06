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

If spec.groundingDataStores is set (one or more Discovery Engine data store
resource paths — a public-website store from adkDeployer.ts
createWebsiteGroundingDataStore, and/or "document" stores for locally-uploaded
files from knowledgeDataStoreExecutor.migrateFileToDocumentStore),
VertexAiSearchTool is wired as the agent's ONLY tool: a single store uses
`data_store_id`, multiple stores combine via `data_store_specs`. ADK (pre-1.16)
only allows VertexAiSearchTool alone on an agent — it cannot be combined with
google_search or any other tool — so `tools` is ignored whenever
groundingDataStores is non-empty.
"""
import argparse
import json
import os
import sys


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

    # Generic REST connector: base URL + auth header from the registry, resolved
    # from Secret Manager the same way.
    base_url_tpl = conn.get("baseUrlTemplate") or ""
    auth_header_tpl = conn.get("authHeaderTemplate") or ""
    conn_name = conn.get("name") or kind or "connector"
    auth_kind = conn.get("authKind") or "bearer"
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
        return fill(auth_header_tpl)

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

        def _fill(tpl: str) -> str:
            out = tpl
            for field in set(re.findall(r"\{(\w+)\}", tpl)):
                out = out.replace(f"{{{field}}}", _secret(field))
            return out

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

    # Build tools from the spec. VertexAiSearchTool requires EXACTLY ONE of
    # data_store_id / search_engine_id per instance (confirmed against the
    # installed google-adk 2.5.0 source, vertex_ai_search_tool.py's own
    # constructor: it raises "Either data_store_id or search_engine_id must be
    # specified" unless exactly one is set — data_store_specs is NOT a way to
    # combine independent stores, it's a scoping filter that's only valid
    # ALONGSIDE search_engine_id, which we don't have/want here since that
    # would mean searching a whole Discovery Engine "engine" resource instead
    # of the specific per-agent stores this pipeline resolved). So multiple
    # data stores become multiple VertexAiSearchTool instances instead, one
    # per store, each with bypass_multi_tools_limit=True — that flag (present
    # on this ADK version, not documented anywhere in this codebase before
    # this fix) makes ADK auto-wrap each as a DiscoveryEngineSearchTool when
    # there's more than one tool on the agent, instead of rejecting the
    # combination outright (see llm_agent.py's _convert_tool_union_to_tools).
    # Harmless to set even when there's only one store: ADK only applies the
    # wrapping when multiple tools are actually present.
    tools = []
    grounding_data_stores = spec.get("groundingDataStores") or []
    grounding_engine_configs = spec.get("groundingEngineServingConfigs") or []
    live_connectors = spec.get("liveConnectors") or []
    try:
        if grounding_engine_configs or grounding_data_stores:
            from google.adk.tools import VertexAiSearchTool
            # Prefer engine serving config paths (requires a search engine with serving config).
            # Falls back to data_store_id, which requires default_serving_config on the store.
            for sc in grounding_engine_configs:
                tools.append(VertexAiSearchTool(search_engine_id=sc, bypass_multi_tools_limit=True))
            for ds in grounding_data_stores:
                tools.append(VertexAiSearchTool(data_store_id=ds, bypass_multi_tools_limit=True))
        elif "googleSearch" in (spec.get("tools") or []):
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
        for conn in live_connectors:
            tools.append(_build_live_connector_tool(conn, args.project))
    except Exception as e:  # noqa: BLE001
        emit({"error": f"tool wiring failed: {e}"}); return

    try:
        root_agent = Agent(
            name=spec.get("name", "migrated_agent"),
            model=spec.get("model", "gemini-2.5-flash"),
            description=spec.get("description", ""),
            instruction=spec.get("instruction", "") or "You are a helpful assistant.",
            tools=tools,
        )
    except Exception as e:  # noqa: BLE001
        emit({"error": f"agent build failed: {e}"}); return

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
            # google-cloud-discoveryengine is REQUIRED as soon as an agent has more
            # than one tool. With bypass_multi_tools_limit=True, ADK re-wraps each
            # VertexAiSearchTool as a DiscoveryEngineSearchTool, whose module does
            # `from google.cloud import discoveryengine_v1beta` — not a dependency of
            # aiplatform or google-adk. Without it the deployment succeeds and then
            # every single turn fails at inference with
            #   ImportError: cannot import name 'discoveryengine_v1beta' from 'google.cloud'
            # returning an EMPTY answer (verified live 2026-08-06 on two deployments).
            # Single-tool agents never take that code path, which is why grounding-only
            # agents worked and adding any second tool broke them.
            #
            # Secrets are read over REST with google-auth (already an aiplatform dep)
            # rather than via google-cloud-secret-manager — one less package in a
            # namespace that has already proven fragile here.
            requirements=[
                "google-cloud-aiplatform[agent_engines,adk]",
                "google-adk",
                "google-cloud-discoveryengine",
            ],
        )
        emit({"reasoningEngine": remote.resource_name})
    except Exception as e:  # noqa: BLE001
        emit({"error": f"deploy failed: {e}"})


if __name__ == "__main__":
    main()
