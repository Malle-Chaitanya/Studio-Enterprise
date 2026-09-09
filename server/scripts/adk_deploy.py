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
import contextvars
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
# ---------------------------------------------------------------------------
# WHO IS CALLING.
#
# Copilot Studio tools can run under the SIGNED-IN USER's own connection (`invoker`)
# rather than one connection the author configured (`maker`). Reproducing that needs the
# caller's identity at tool-call time, and Gemini Enterprise supplies it: it drives the ADK
# session contract (`create_session` / `stream_query`), and the `user_id` it passes is the
# end user's email -- observed live on deployed engines ("zara@storefuze.com").
#
# Captured in a ContextVar from a before-tool callback rather than threaded through every
# connector module: `_secret` is the ONE place a credential is read, and every connector
# already goes through it. Adding a parameter to eleven tool modules to carry the same fact
# would be eleven chances for one of them to forget.
# NO module-level ContextVar here, deliberately. `_secret` below is closed over by EVERY
# connector tool, and the tools are what Vertex pickles — so anything `_secret` can reach ends
# up in the pickle graph whether or not the caller callback is wired. A ContextVar there made
# every ADK deploy fail with "Failed to serialize agent engine" and silently fall back to
# low-code create. Reproduced: cloudpickle.dumps -> TypeError: cannot pickle ContextVar.


def _caller_user_id(tool_context) -> str:  # noqa: ANN001
    """Best-effort read of the invoking end user from an ADK tool context.

    Tries several shapes on purpose: the attribute path has moved between google-adk
    releases and the deployed container's version is not pinned by us. Returns "" when
    nothing is found -- callers MUST treat that as "unknown", never as "shared".

    PRINTS which shape resolved and to what value (never which failed silently) — a plain
    print, not a log/tool-response field, because Cloud Logging redacts actual conversation
    content for gen_ai events ("<elided>") but does NOT redact plain stdout. Confirmed live
    2026-09-08: a real invoker-mode Gmail tool failed with a generic "permissions" message
    the model paraphrased, and there was no way to see WHICH identity (if any) it actually
    tried to impersonate without this — silently debugging identity resolution blind is not
    something a real customer's support case should ever have to repeat.
    """
    shapes = (
        ("_invocation_context.session.user_id", lambda: tool_context._invocation_context.session.user_id),  # noqa: SLF001
        ("invocation_context.session.user_id", lambda: tool_context.invocation_context.session.user_id),
        ("session.user_id", lambda: tool_context.session.user_id),
        ("state['_caller_user_id']", lambda: tool_context.state.get("_caller_user_id")),
    )
    for label, get in shapes:
        try:
            v = get()
            print(f"[caller-id] {label} -> {v!r}")
            if v:
                return str(v)
        except Exception as e:  # noqa: BLE001
            print(f"[caller-id] {label} -> FAILED: {e!r}")
            continue
    print("[caller-id] no shape resolved a value — returning empty")
    return ""


# Empty at build time; holds the ContextVar once the container makes its first tool
# call. See _caller_var() for why this indirection is load-bearing.
_CALLER_HOLDER: dict = {}


def _caller_var():
    """The ContextVar holding the end user for the tool call running right now.

    CREATED LAZILY, ON PURPOSE, NOT AT MODULE LEVEL. Vertex pickles the agent, this file
    runs as __main__, so cloudpickle serialises the tool closures BY VALUE and everything
    they reference is dragged into the pickle graph. A module-level ContextVar there made
    EVERY ADK deploy fail with "Failed to serialize agent engine" and silently fall back to
    low-code create -- reproduced as cloudpickle.dumps -> TypeError: cannot pickle
    '_contextvars.ContextVar' object. An empty dict pickles fine, and the ContextVar is
    only ever built on the first tool call, which happens inside the deployed container
    after unpickling. `_assert_caller_channel_unarmed` enforces that nothing arms it early.

    A ContextVar and not a plain dict because tool calls run CONCURRENTLY in one container:
    a shared global would let two callers observe each other's identity, which is exactly
    the cross-user leak per-user credentials exist to prevent. ContextVar is per-task.
    """
    var = _CALLER_HOLDER.get("var")
    if var is None:
        import contextvars

        var = contextvars.ContextVar("csge_caller_user_id", default="")
        _CALLER_HOLDER["var"] = var
    return var


def _assert_caller_channel_unarmed() -> None:
    """Refuse to deploy if anything created the ContextVar before pickling.

    This is the regression that cost a full migration run: the failure is invisible at
    deploy time (Vertex reports serialization failure, the code falls back to low-code
    create, and the agent comes out PRIVATE and unshared). Checking here turns a silent
    fallback into a loud error next to its cause.
    """
    if _CALLER_HOLDER:
        raise RuntimeError(
            "caller channel armed at build time: a ContextVar would enter the pickle "
            "graph and deployment would fail. Something called _caller_var() outside a "
            "tool call."
        )


def _bind_caller(fn):
    """Wrap one per-user tool so `_secret` can see who is asking.

    ADK injects `tool_context` into any tool whose signature declares it, and omits that
    parameter from the declaration the model sees. So the caller arrives as an ordinary
    argument at call time -- no ambient global, and nothing added to the pickle graph
    beyond an empty dict.

    Applied ONLY to connectors marked perUser. A shared-credential tool keeps exactly the
    signature and behaviour it has today, so this cannot regress the connectors that
    already work.
    """
    import functools
    import inspect

    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        # Not introspectable (a tool object rather than a plain function). Leave it be:
        # `_secret` still fails closed, which is the safe direction.
        return fn
    if "tool_context" in sig.parameters:
        return fn

    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def _wrapper(*a, tool_context=None, **kw):
            token = _caller_var().set(_caller_user_id(tool_context))
            try:
                return await fn(*a, **kw)
            finally:
                _caller_var().reset(token)
    else:
        @functools.wraps(fn)
        def _wrapper(*a, tool_context=None, **kw):
            token = _caller_var().set(_caller_user_id(tool_context))
            try:
                return fn(*a, **kw)
            finally:
                # reset(), not set(""): nested/concurrent calls each restore their own
                # previous value, so one tool finishing cannot blank another's caller.
                _caller_var().reset(token)

    # Rebuild the signature so ADK sees `tool_context` and the model does not. A
    # keyword-only parameter must precede **kwargs, hence the split rather than an append.
    params = list(sig.parameters.values())
    var_kw = [p for p in params if p.kind == inspect.Parameter.VAR_KEYWORD]
    rest = [p for p in params if p.kind != inspect.Parameter.VAR_KEYWORD]
    try:
        from google.adk.tools import ToolContext as _ToolContext
        annotation = _ToolContext
    except Exception:  # noqa: BLE001 -- older/newer adk layouts; the NAME is what ADK matches
        annotation = inspect.Parameter.empty
    ctx_param = inspect.Parameter(
        "tool_context",
        inspect.Parameter.KEYWORD_ONLY,
        default=None,
        annotation=annotation,
    )
    _wrapper.__signature__ = sig.replace(parameters=rest + [ctx_param] + var_kw)
    ann = dict(getattr(fn, "__annotations__", {}) or {})
    if annotation is not inspect.Parameter.empty:
        ann["tool_context"] = annotation
    _wrapper.__annotations__ = ann
    return _wrapper


def _secret_safe(part: str) -> str:
    """Mirror of secretSafe() in services/connectorCredentials.ts.

    The server computes the shared id and the container derives the per-user one from it;
    if these two safings ever disagree the lookup misses and every call fails at inference.
    Keep them identical.
    """
    return re.sub(r"[^a-zA-Z0-9-]", "-", part).lower()


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
    # See LiveConnectorSpec.perUser (services/adkDeployer.ts): the source tool ran under the
    # caller's own connection, so this connector must too.
    per_user = bool(conn.get("perUser"))
    # Which credential fields belong to the PERSON rather than the app. Server-populated
    # from the registry's userAuth block; empty means this connector has no delegated
    # sign-in, and every per-user call must fail closed.
    per_user_fields = set(conn.get("perUserFields") or [])
    # IMPERSONATION keeps the SHARED app credential and names the caller on the request
    # instead (MSCRMCallerID, or /users/{caller} on Graph). So none of the per-user secret
    # logic below applies to it: there are deliberately no per-user secrets, and treating
    # its empty `perUserFields` as "no per-user sign-in" makes every call fail closed for
    # everyone -- which is exactly what a live two-caller test caught.
    impersonating = bool(conn.get("perUser")) and conn.get("perUserMode") == "impersonate"

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

        # PER-USER CREDENTIALS: the source tool ran as whoever was asking, so this one must
        # too. The id is the shared one plus the caller -- see connectorUserSecretId() in
        # services/connectorCredentials.ts, which builds the same name server-side.
        #
        # There is NO fallback to the shared credential, deliberately. Falling back would
        # make an unconfigured user silently act as one shared account: mail from the wrong
        # mailbox, another person's CRM records -- the exact access collapse per-user exists
        # to prevent, and invisible because the call succeeds. Failing here surfaces as an
        # error the user can act on, which is the honest outcome.
        if per_user and not impersonating and field in per_user_fields:
            # Only the DELEGATED fields are personal. A connector's client_id and
            # client_secret identify the OAuth app, are the same for everyone, and must
            # keep resolving to the shared secret -- per-user-ing them would break the
            # token exchange for every user including ones who have consented.
            caller = _caller_var().get("")
            if not caller:
                raise RuntimeError(
                    f"{conn_name}: this tool runs as whoever is asking, but the caller "
                    "could not be identified, so it cannot pick their credential. "
                    "(The ADK build in this container may not support tool_context.)"
                )
            secret_id = f"{secret_id}-u-{_secret_safe(caller.lower())}"
        elif per_user and not impersonating:
            # perUser with no delegated fields means the server found no per-user flow for
            # this connector (see supportsUserAuth / ConnectorDef.userAuth). Fail closed.
            #
            # NOT softened to the shared credential, here or above: falling back would make
            # every user of this tool act as ONE account -- mail from the wrong mailbox,
            # another person's CRM records -- the exact access collapse per-user exists to
            # prevent, and invisible because the call would succeed.
            if not per_user_fields:
                raise RuntimeError(
                    f"{conn_name}: this tool ran under each user's own credentials in "
                    "Copilot Studio and this connector has no per-user sign-in, so it "
                    "cannot run for anyone. See the migration report's toolCredentials note."
                )

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(_AuthRequest())
        url = (
            f"https://secretmanager.googleapis.com/v1/projects/{project}"
            f"/secrets/{secret_id}/versions/latest:access"
        )
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {creds.token}"})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                payload = _json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            # A missing PER-USER secret is not a fault, it is a user who has not connected
            # their account yet -- by far the most common way this call fails. Saying so
            # turns a raw 404 in the model's context into an instruction it can relay.
            status = getattr(e, "code", None)
            if per_user and not impersonating and field in per_user_fields and status in (403, 404):
                raise RuntimeError(
                    f"{conn_name}: this tool uses each person's own account, and there is "
                    "no stored connection for you yet. Connect your account in CloudFuze "
                    "Studio Migrate, then try again."
                ) from None
            raise
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

        # CACHE KEY INCLUDES THE CALLER. The cache lives for the container's lifetime and is
        # shared by every request it serves; keyed only by connector, a per-user token minted
        # for one person would be handed to the next -- one user reading another's mailbox,
        # which is precisely the collapse per-user credentials exist to prevent, and it would
        # look like a cache hit rather than a bug. Shared-credential connectors keep the old
        # single key, so their behaviour is unchanged.
        cache_key = f"token:{_caller_var().get('')}" if per_user else "token"
        exp_key = f"expires_at:{_caller_var().get('')}" if per_user else "expires_at"
        cached = token_cache.get(cache_key)
        if cached and token_cache.get(exp_key, 0) > time.time() + 60:
            return cached

        if auth_kind == "google-service-account":
            # Sign a JWT with the service-account key and trade it for a token.
            import google.auth.transport.requests
            from google.oauth2 import service_account

            info = _json.loads(_secret("service_account_json"))
            creds = service_account.Credentials.from_service_account_info(
                info, scopes=[scope or "https://www.googleapis.com/auth/cloud-platform"]
            )
            # Domain-wide delegation names the person AT MINT TIME, so this is the single
            # place a Google connector becomes per-user: every tool built on the resulting
            # token -- Drive create/update/delete, Gmail send -- acts as that subject without
            # knowing the caller exists. No identity map is involved, unlike Outlook: the ADK
            # session's user_id is already a Google address, which is what DWD wants.
            if impersonating and conn.get("impersonationResolve") == "google-dwd-subject":
                subject = _caller_var().get("")
                print(f"[mint-token] {conn_name}: resolved caller subject = {subject!r}")
                if not subject:
                    # Fail closed. Falling back to `impersonate_email` here would quietly run
                    # an invoker connector as one pinned person and, for Gmail, SEND AS THEM.
                    raise RuntimeError(
                        f"{conn_name}: this tool ran under each user's own credentials in "
                        f"Copilot Studio, but the caller could not be identified, so it will "
                        f"not act as anyone."
                    )
                creds = creds.with_subject(subject)
                try:
                    creds.refresh(google.auth.transport.requests.Request())
                except Exception as e:  # noqa: BLE001
                    # Plain print, not just re-raise: the caller's own try/except turns this
                    # into a tool-response error dict, which Cloud Logging redacts for gen_ai
                    # events — this is the one place the REAL Google-side rejection reason
                    # (invalid_grant / unauthorized_client / "Client is unauthorized...") is
                    # still visible in the logs at all.
                    print(f"[mint-token] {conn_name}: DWD subject={subject!r} refresh FAILED: {e!r}")
                    raise
                token_cache[cache_key] = creds.token
                token_cache[exp_key] = time.time() + 3000
                return creds.token
            else:
                try:
                    subject = _secret("impersonate_email")
                    if subject:
                        creds = creds.with_subject(subject)
                except Exception:  # noqa: BLE001 — optional field
                    pass
            creds.refresh(google.auth.transport.requests.Request())
            token_cache[cache_key] = creds.token
            token_cache[exp_key] = time.time() + 3000
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
            # Entra issues access tokens PER RESOURCE, so a refresh token consented for both
            # Graph and Dataverse mints only one of them per exchange. Omitting the scope
            # lets the provider choose, which fails later as a 401 against the other
            # resource -- indistinguishable from a permissions problem. Name it.
            if scope:
                form["scope"] = fill(scope)
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
        token_cache[cache_key] = token
        token_cache[exp_key] = time.time() + int(payload.get("expires_in") or 3600)
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

    def _caller() -> str:
        """Who is asking, for connectors that impersonate rather than hold a per-user token.

        Empty when the caller could not be identified. Callers MUST treat that as unknown and
        refuse -- running the shared app identity instead would return one person's records to
        everybody, which is the exact failure per-user exists to prevent.
        """
        return _caller_var().get("")

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

    # CROSS-VENDOR, third of three (after gmail, googlechat): Copilot's Office 365 Outlook
    # Calendar operations -> Google Calendar. Requires calendar scope + an
    # `impersonate_email` secret, same DWD pattern as gmail. See connector_tools/calendar.py
    # for the fidelity divergences (Show As -> transparency, single primary calendar only)
    # this mapping cannot avoid.
    if kind in ("googlecalendar", "calendar"):
        from connector_tools.calendar import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    # CROSS-VENDOR, fourth: Copilot's Office 365 Outlook Contacts operations -> Google
    # Contacts (People API). Requires the `contacts` scope + an `impersonate_email`
    # secret, same DWD pattern as gmail/calendar. See connector_tools/contacts.py for
    # the fidelity divergences (folders vs groups, non-portable resourceName ids) this
    # mapping cannot avoid. No Keep-Microsoft equivalent exists yet — see
    # connectors/equivalence.ts's mcp_ContactsManagement row and
    # db/repos/agentSurfaceChoice.ts's 'shared_office365:contacts' entry.
    if kind in ("googlecontacts", "contacts"):
        from connector_tools.contacts import build_tools as _build
        return _build(conn, _secret, _mint_token, _auth_header, _fill)

    # Mail that STAYS in Microsoft: the agent moves to Gemini, Graph still serves its mail.
    # Requires app-only ms_graph credentials plus Mail.ReadWrite / Mail.Send APPLICATION
    # permissions with admin consent.
    if kind == "outlook":
        from connector_tools.outlook import build_tools as _build
        # `caller` so a per-user mailbox is the ASKER's own, not one pinned per agent.
        return _build(conn, _secret, _mint_token, _auth_header, _fill, caller=_caller)

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
    # `caller` only here: generic_rest owns the bound-operation path, which is where an
    # impersonating connector (Dataverse) actually makes its call.
    return _build(conn, _secret, _mint_token, _auth_header, _fill, caller=_caller)


# ---------------------------------------------------------------------------
# MCP-server tools (Track C).
#
# Two paths here, NOT equally proven:
#
#   (a) Agent-Registry path (mcp["registryServerName"] set) — go through the
#       DESTINATION project's own Agent Registry to connect/discover/call a
#       server. CORRECTED 2026-09-07 against a live installed google-adk 2.8.0
#       and Google's own auto-generated code snippet for a real registry entry
#       (Agent Platform console -> Agent Registry -> MCP Servers -> any entry ->
#       Overview -> Code Snippet): the real class is
#       `google.adk.integrations.agent_registry.agent_registry.AgentRegistry`
#       (NOT google.adk.tools.mcp_tool.agent_registry — that path was an
#       educated guess from an earlier session and does not exist in 2.8.0),
#       constructed as `AgentRegistry(project_id=..., location=...)`, and
#       `get_mcp_toolset(mcp_server_name)` takes NO tool_filter parameter at
#       all — it returns every tool the server exposes, full stop. Re-check
#       against whatever google-adk version _pinned() reports if this ever
#       raises ImportError again — this SDK's internal module layout has moved
#       more than once already (see McpHttpClientFactory in the module
#       docstring history).
#
#       Because there is no mechanism-level filter, restricting which of the
#       server's tools the model actually uses (to respect the source agent's
#       own `tools` allow-list, or a destination-side safety narrowing) can
#       ONLY be done via instruction today, not construction. See
#       `_mcp_tool_filter_instruction` below.
#
#       Live-tested 2026-09-07 against calendarmcp.googleapis.com (Google
#       Calendar's registry entry, 8 real tools: list_events, get_event,
#       list_calendars, suggest_time, create_event, update_event, delete_event,
#       respond_to_event — confirmed via `gcloud agent-registry mcp-servers
#       describe`) using a personal-account ADC token: toolset construction
#       succeeded, but the MCP session itself failed ("Session terminated") —
#       most likely because gcloud's shared OAuth client is blocked from
#       requesting the Calendar scope for personal logins (a real, Google-wide
#       policy, confirmed via the console's own warning text), not a defect in
#       this construction path. A deployed Reasoning Engine authenticates as
#       its OWN service account, not a personal login, so this specific
#       failure mode should not recur in a real deploy — but that has NOT been
#       independently confirmed with a service-account run as of this change.
#       Treat that gap honestly until it has been.
#   (b) Raw-URL path (mcp["serverUrl"] only, no registryServerName) — required
#       for every CUSTOM/third-party connector (HubSpot etc.), since those
#       servers are never in Google's Agent Registry. Built the way ADK's own
#       McpToolset + StreamableHTTPConnectionParams are documented to work, but
#       NOT live-tested end to end against a real third-party server as of this
#       change. Treat a deploy that used this path as unverified — surface that
#       in the report — until it has been.
#
# Root cause a full day was spent on (2026-08-31/09-01), load-bearing for BOTH
# paths: an MCP server can ADVERTISE a tool over the raw protocol (`tools/list`)
# that the calling platform never actually sanctions for execution — ADK's own
# runtime error listed `list_engines` as "available" and it still 403'd on every
# call, while `search`/`conversational_search` (the only two tools Discovery
# Engine's Agent Registry entry lists on its own "Tools" tab) worked cleanly.
# The tool-list instruction below is therefore NOT simply "pass through
# mcp['tools'] from the source agent" — that would tell the model to try a tool
# the destination may never actually be able to call. It narrows what's already
# offered; it cannot widen it.
# ---------------------------------------------------------------------------
def _mcp_tool_filter_instruction(mcp: dict) -> str:
    """Best-effort tool restriction for a registry toolset that has no real
    tool_filter mechanism (see module comment above). Returns an instruction
    fragment naming the allowed tools, or '' when the source allowed everything
    ('all' selection) and there is nothing to narrow."""
    tools = mcp.get("tools") or []
    if not tools:
        return ""
    names = ", ".join(tools)
    return (
        f"\nFor the '{mcp.get('id')}' tools, you are ONLY allowed to use: {names}. "
        f"Never call any other tool from that server, even if it looks relevant — "
        f"the source agent this was migrated from was never granted access to it.\n"
    )


def _build_mcp_toolset(mcp: dict, project: str):
    """Return a real ADK MCP toolset for one migrated mcp-server tool entry.

    `mcp` is one entry of spec["mcpTools"] — see AdkSpec.mcpTools in
    adkDeployer.ts for the exact shape and its own load-bearing caveats
    (secretIds is honestly empty for most tools today; tools is the intersection
    the SOURCE allowed, not a guarantee the destination will honor all of it;
    it is enforced by instruction only, not by construction — see
    _mcp_tool_filter_instruction above).

    Raises on failure — the caller wraps every entry in the same
    fail-the-whole-deploy try/except every other tool kind in this file already
    uses, so a broken MCP tool is reported, not silently dropped.
    """
    from google.adk.tools.mcp_tool.mcp_toolset import McpToolset  # noqa: F401 — availability check

    registry_name = mcp.get("registryServerName")
    if registry_name:
        from google.adk.integrations.agent_registry.agent_registry import AgentRegistry

        registry = AgentRegistry(project_id=project, location=mcp.get("registryLocation") or "global")
        return registry.get_mcp_toolset(registry_name)

    server_url = mcp.get("serverUrl")
    if not server_url:
        raise RuntimeError(
            f"mcp tool '{mcp.get('id')}' has neither registryServerName nor serverUrl — nothing to connect to"
        )

    from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams

    auth_kind = mcp.get("authKind")
    secret_ids = mcp.get("secretIds") or {}
    headers: dict = {}
    if auth_kind and secret_ids:
        # Mirrors _build_live_connector_tool's own _secret() one-for-one — the same
        # REST-not-client reasoning applies identically here (see that function's
        # docstring: the google-cloud-secret-manager client shadows the google.cloud
        # namespace package and silently breaks VertexAiSearchTool).
        import base64
        import json as _json
        import urllib.request

        import google.auth
        from google.auth.transport.requests import Request as _AuthRequest

        def _secret(field: str) -> str:
            secret_id = secret_ids.get(field)
            if not secret_id:
                raise RuntimeError(f"mcp tool '{mcp.get('id')}': no secret id configured for field '{field}'")
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

        if auth_kind == "bearer":
            token = _secret("token")
            headers["Authorization"] = token if " " in token.strip() else f"Bearer {token.strip()}"
        else:
            # oauth2-*/basic-* raw-URL MCP auth is not built yet — every credential kind
            # actually proven so far (Secret Manager fetch, header shape) is the bearer
            # one, since that is what the live-tested registry path also uses under the
            # hood. Fail loud rather than silently connecting with no auth at all.
            raise RuntimeError(f"mcp tool '{mcp.get('id')}': unsupported authKind '{auth_kind}' for a raw-URL MCP server")

    return McpToolset(
        connection_params=StreamableHTTPConnectionParams(url=server_url, headers=headers or None),
        tool_filter=tool_filter,
    )


# ---------------------------------------------------------------------------
# Migrated Agent Flow tools.
#
# `flow` is one entry of spec["flowTools"] — see AdkSpec.flowTools in adkDeployer.ts.
# `executeUrl` already points at a real, already-created Application Integration
# (services/applicationIntegration.ts ran before this deploy, in Phase 2) — this
# function has nothing to discover or build on the Google-resource side, only a real
# HTTP call to make. Generalizes the hand-built draft_follow_up_email/
# get_rate_sheet_band prototypes this project proved live earlier: same POST-with-
# minted-SA-token shape, but the parameter LIST is generic (from `inputParameters`),
# not hardcoded per flow.
#
# Signature-generation mirrors connector_tools/generic_rest.py's own convention
# exactly (thin exec'd wrapper calling a real closure, docstring set separately) —
# see that module's comment for why a real signature is load-bearing: ADK builds
# the tool's schema from the function's signature, so **kwargs would describe no
# arguments to the model at all.
# ---------------------------------------------------------------------------
def _build_flow_tool(flow: dict):
    """Build a real ADK function tool for one migrated Agent Flow."""
    import re as _re
    import json as _json
    import urllib.request
    import google.auth
    from google.auth.transport.requests import Request as _AuthRequest

    def _invoke(**kwargs) -> dict:
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        creds.refresh(_AuthRequest())
        req = urllib.request.Request(
            flow["executeUrl"],
            data=_json.dumps(kwargs).encode("utf-8"),
            headers={"Authorization": f"Bearer {creds.token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return _json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            try:
                detail = e.read().decode("utf-8")[:500]  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                detail = str(e)
            return {"error": f"{flow.get('name', 'migrated flow')} failed: {detail}"}

    params = flow.get("inputParameters") or []
    # Each Application Integration parameter key is already a sanitized identifier
    # (see sanitizeIdent in flowMapper.ts) — safe to use directly as a Python arg name.
    arg_names = [p["key"] for p in params]

    # ADK derives the Gemini function-calling schema from THIS signature, so a
    # dataType-aware type hint is not cosmetic: typing a limit/amount field as `str`
    # let the model pass literal text straight through ("$4M"), which a downstream
    # numeric parse then turned into NaN/None with no error — every row comparison
    # silently failed and the tool reported "no rate found" for an amount that WAS
    # in range. Typing it `float` forces the model to emit an actual JSON number
    # before the call ever leaves the model, not a string it merely looks numeric.
    def _py_type(p: dict) -> tuple[str, str]:
        dt = (p.get("dataType") or "").lower()
        if dt == "number":
            return "float", "0.0"
        if dt == "boolean":
            return "bool", "False"
        return "str", '""'

    sig = ", ".join(f"{p['key']}: {_py_type(p)[0]} = {_py_type(p)[1]}" for p in params)
    call_args = ", ".join(f"{n}={n}" for n in arg_names)
    tool_name = _re.sub(r"[^a-zA-Z0-9_]", "_", (flow.get("name") or "migrated_flow")).strip("_").lower() or "migrated_flow"
    src = f"def {tool_name}({sig}) -> dict:\n    return _invoke({call_args})\n"
    ns = {"_invoke": _invoke}
    exec(src, ns)  # noqa: S102 - generated from our own spec, never from model output
    fn = ns[tool_name]

    def _arg_line(p: dict) -> str:
        label = p.get("displayName") or p["key"]
        if (p.get("dataType") or "").lower() == "number":
            return (
                f"    {p['key']}: {label} — a plain number (e.g. 4000000). Expand any "
                "shorthand or currency formatting the caller used ($4M -> 4000000, "
                "4,000,000 -> 4000000) before calling this tool; never pass the original "
                "text.\n"
            )
        return f"    {p['key']}: {label}\n"

    arg_doc = "".join(_arg_line(p) for p in params)
    doc = str(flow.get("description") or f"Calls the migrated flow \"{flow.get('name')}\".") + "\n"
    if arg_doc:
        doc += "\nArgs:\n" + arg_doc
    doc += "\nReturns:\n    dict with the flow's real output fields, or an 'error' key.\n"
    fn.__doc__ = doc
    return fn


# ---------------------------------------------------------------------------
# Full-tenant-cutover Cloud SQL tools.
#
# `spec` is one entry of AdkSpec["cloudSqlTools"] — a Dataverse connector tool's table,
# already copied into Cloud SQL by services/cloudSqlMigration.ts (Phase 2, before this
# deploy runs). This is the LIVE-VERIFIED connection shape (real test instance, 2026-09-08,
# deleted after verification): IAM database auth, ZERO stored password. Two real gotchas
# proven live and preserved here on purpose:
#   1. `Connector(credentials=creds, quota_project=...)` — NOT `creds.with_quota_project()`,
#      which silently does not propagate into the Connector's own internal HTTP client and
#      403s with a confusing "wrong project" error that looks like a permissions problem.
#   2. The IAM database username is the service account email WITH ITS TRAILING
#      ".gserviceaccount.com" STRIPPED — using the full email silently fails to
#      authenticate.
#
# SQL INJECTION DEFENSE: the model supplies a COLUMN NAME (to filter on) and a VALUE.
# Column names cannot be parameterized in SQL — the allowlist against `spec["columns"]`
# (the table's REAL columns, from services/cloudSqlMigration.ts, never model-supplied) is
# the actual defense, not a formality. The VALUE is always sent as a real parameterized
# bind, never string-interpolated, regardless of what it contains.
# ---------------------------------------------------------------------------
def _cloudsql_json_safe(value):
    """pg8000 hands back native Python types for Postgres columns that have no direct JSON
    equivalent — NUMERIC as decimal.Decimal, TIMESTAMPTZ/DATE as datetime objects, BYTEA as
    bytes. The ADK/genai SDK eventually calls json.dumps() on the tool's return value to send
    it back to the model, and plain json.dumps() has no idea what to do with any of those —
    it raises `TypeError: Object of type Decimal is not JSON serializable` and silently kills
    the ENTIRE agent turn (confirmed live 2026-09-08 via Cloud Logging: "Dynamic node ...
    failed", no error ever reaching the chat UI — the tool call itself shows as succeeded,
    then the conversation just goes idle). Fixing only Decimal would have left the identical
    crash waiting for the first table with a date column referenced — which is effectively
    every Dataverse table, since createdon/modifiedon are standard system columns — so this
    converts every type pg8000 can hand back that isn't already JSON-safe, not just the one
    that happened to get hit first."""
    import datetime as _datetime
    import decimal as _decimal

    if isinstance(value, _decimal.Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, (_datetime.datetime, _datetime.date)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value).decode("utf-8", errors="replace")
    return value


def _build_cloudsql_tool(spec: dict):
    """Build a real ADK function tool for one Dataverse table migrated to Cloud SQL."""
    import re as _re

    table = spec["table"]
    columns = spec.get("columns") or []
    instance_connection_name = spec["instanceConnectionName"]
    database = spec["database"]

    def _query(filter_column: str, filter_value: str) -> dict:
        if filter_column not in columns:
            return {
                "error": f"'{filter_column}' is not a real column on \"{table}\". "
                f"Valid columns: {', '.join(columns)}"
            }
        import google.auth
        from google.cloud.sql.connector import Connector, IPTypes
        import pg8000

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        project = instance_connection_name.split(":")[0]
        connector = Connector(credentials=creds, quota_project=project)
        try:
            # The connecting identity is always THIS deployment's own (attached) service
            # account. `creds.service_account_email` can read back the literal string
            # "default" before the credentials have been refreshed against real Compute
            # Engine/Reasoning Engine metadata — asking the metadata server directly is the
            # reliable way to resolve it, with the credentials object as a local-dev fallback.
            import urllib.request as _urlreq
            try:
                _req = _urlreq.Request(
                    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
                    headers={"Metadata-Flavor": "Google"},
                )
                with _urlreq.urlopen(_req, timeout=5) as _resp:
                    sa_email = _resp.read().decode("utf-8").strip()
            except Exception:  # noqa: BLE001
                sa_email = getattr(creds, "service_account_email", "") or ""
            iam_user = _re.sub(r"\.gserviceaccount\.com$", "", sa_email)
            conn = connector.connect(
                instance_connection_name,
                "pg8000",
                user=iam_user,
                db=database,
                enable_iam_auth=True,
                ip_type=IPTypes.PUBLIC,
            )
            try:
                cur = conn.cursor()
                # Case-insensitive PARTIAL match (`::text ILIKE '%value%'`), not exact
                # equality — confirmed live 2026-09-08: a real chat user said "Meridian
                # Foods" while the migrated row's actual value is "Meridian Foods Inc.",
                # and an exact match silently returned zero rows for a client that was
                # right there in the table. The model calling this tool almost never knows
                # a stored value's literal punctuation/suffix/casing verbatim — it only has
                # whatever phrasing the end user typed. `::text` lets this apply uniformly
                # to any column type (numeric/date columns included) without needing column
                # type metadata here. This also restores parity with the source Dataverse
                # "List rows" action this tool replaces, which itself matches text filters
                # with `contains()`, not exact equality — so this is a fidelity fix, not a
                # new behavior invented for Cloud SQL.
                cur.execute(
                    f'SELECT * FROM "{table}" WHERE "{filter_column}"::text ILIKE %s LIMIT 20',
                    (f"%{filter_value}%",),
                )
                col_names = [d[0] for d in cur.description]
                rows = [
                    {k: _cloudsql_json_safe(v) for k, v in zip(col_names, r)}
                    for r in cur.fetchall()
                ]
                cur.close()
                return {"rows": rows, "count": len(rows)}
            finally:
                conn.close()
        except Exception as e:  # noqa: BLE001
            return {"error": f"{table} lookup failed: {e}"}
        finally:
            connector.close()

    tool_name = _re.sub(r"[^a-zA-Z0-9_]", "_", spec.get("name") or f"lookup_{table}").strip("_").lower()
    src = f"def {tool_name}(filter_column: str, filter_value: str) -> dict:\n    return _query(filter_column, filter_value)\n"
    ns = {"_query": _query}
    exec(src, ns)  # noqa: S102 - generated from our own spec, never from model output
    fn = ns[tool_name]
    fn.__doc__ = (
        str(spec.get("description") or f'Looks up rows from "{table}".') + "\n\n"
        "Args:\n"
        f"    filter_column: which column to filter on. Must be exactly one of: {', '.join(columns)}\n"
        "    filter_value: text to look for in that column (case-insensitive, partial match — "
        "you do not need the exact/full stored value, e.g. a partial client name works).\n\n"
        "Returns:\n"
        "    dict with 'rows' (list, up to 20) and 'count', or an 'error' key.\n"
    )
    return fn


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
    # Populated inside the mcpTools loop below; declared here so it's always defined
    # by the time naming_rule is built further down, even on an empty mcpTools list.
    mcp_tool_filter_instructions = ""
    # Set when the single-store branch below appends its VertexAiSearchTool, so
    # built_tool_names (near the end of this function) can report its TRUE
    # query-time name instead of whatever this raw, pre-wrap object's own
    # name/__name__ happens to be. See that branch's comment for why the two
    # are guaranteed to differ.
    single_grounding_tool = None
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
            single_grounding_tool = VertexAiSearchTool(
                data_store_id=grounding_data_stores[0]["resourcePath"],
                bypass_multi_tools_limit=bool(live_connectors),
            )
            tools.append(single_grounding_tool)
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
                # A builder returning None (silently, no exception) used to reach
                # Agent(tools=[...]) as a literal None entry, which ADK/pydantic rejects with
                # an opaque "tools.0.callable ... input_value=None" error that names neither
                # the connector nor which builder produced it — surfaced live 2026-09-06 via
                # a real Deal Desk migration, root cause never pinned to a specific builder.
                # Never let it reach Agent() silently again: name it and skip it instead.
                if fn is None:
                    emit({"warn": f"connector tool build for kind={conn.get('kind') or conn.get('id')} returned no tool — skipped, not wired."})
                    continue
                # Per-user tools need to know WHO is calling. Wrapping only these leaves
                # every shared-credential tool byte-identical to what already deploys and
                # works, so this can only regress connectors that fail closed today.
                if conn.get("perUser"):
                    fn = _bind_caller(fn)
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

        # MCP-server tools (Track C) — see _build_mcp_toolset's own module comment
        # for the two paths and which one is actually proven. Same fail-the-whole-
        # deploy semantics as live_connectors above and everything else in this
        # try block: a broken tool must be reported, not silently dropped from an
        # agent whose source genuinely had it.
        #
        # No name-collision handling here unlike live_connectors: a McpToolset
        # exposes however many tools the server advertises, discovered at deploy
        # time, not one renameable Python function — there is no single __name__ to
        # dedupe against used_tool_names. If a name genuinely collides with a live
        # connector's function, ADK's own deploy-time "Duplicate function
        # declaration" error is what surfaces it, the same signal
        # _make_search_tool's module comment already relies on elsewhere in this
        # file — not a silent failure.
        mcp_tool_filter_instructions = ""
        for mcp in (spec.get("mcpTools") or []):
            tools.append(_build_mcp_toolset(mcp, args.project))
            mcp_tool_filter_instructions += _mcp_tool_filter_instruction(mcp)

        # Migrated Agent Flows — see _build_flow_tool's own module comment. Same
        # fail-the-whole-deploy semantics as every other tool kind in this try block.
        for flow in (spec.get("flowTools") or []):
            tools.append(_build_flow_tool(flow))

        # Full-tenant-cutover Dataverse tables migrated to Cloud SQL — see
        # _build_cloudsql_tool's own module comment.
        for cs in (spec.get("cloudSqlTools") or []):
            tools.append(_build_cloudsql_tool(cs))
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
        # A REAL Copilot Studio child agent (AgentIR.TopicIR.isChildAgent) carries its own
        # liveConnectors — the tools extraction found scoped exclusively to it via
        # AgentToolIR.childAgentTopicId (see services/dataverse.ts and orchestrator.ts's
        # topicSubAgents construction). When present, build THIS sub-agent's own tools from
        # its own connector list — reusing the exact same _build_live_connector_tool dispatch
        # the root uses — instead of the root's tools wholesale. An ordinary migrated TOPIC
        # (not a real child agent) has no liveConnectors entry and keeps the previous
        # inherit-all/inherit-none behavior unchanged, so this is purely additive.
        sub_live_connectors = sa.get("liveConnectors") or []
        if sub_live_connectors:
            sub_tools = []
            sub_used_tool_names = set()
            for conn in sub_live_connectors:
                try:
                    built = _build_live_connector_tool(conn, args.project)
                except Exception as e:  # noqa: BLE001
                    emit({"warn": f"sub-agent {sa.get('id')}: connector tool build failed for {conn.get('kind')}: {e}"})
                    continue
                for fn in (built if isinstance(built, (list, tuple)) else [built]):
                    if fn is None:
                        emit({"warn": f"sub-agent {sa.get('id')}: connector tool build for kind={conn.get('kind') or conn.get('id')} returned no tool — skipped, not wired."})
                        continue
                    original = getattr(fn, "__name__", "tool")
                    if original in sub_used_tool_names:
                        i = 2
                        candidate = f"{original}_{i}"
                        while candidate in sub_used_tool_names:
                            i += 1
                            candidate = f"{original}_{i}"
                        try:
                            fn.__name__ = candidate[:60]
                        except (AttributeError, TypeError):
                            pass
                    sub_used_tool_names.add(getattr(fn, "__name__", original))
                    sub_tools.append(fn)
            resolved_tools = sub_tools
        else:
            # Sub-agents inherit nothing implicitly: give them the same tools as the
            # root so a topic that needs SharePoint or a connector can still act.
            resolved_tools = tools if sa.get("inheritTools", True) else []
        sa_kwargs = dict(
            name=_safe_agent_name(sa.get("id") or sa.get("name") or "topic"),
            model=sa.get("model") or spec.get("model", "gemini-2.5-flash"),
            description=sa.get("description") or f"Handles {sa.get('displayName') or sa.get('id')} requests.",
            instruction=sa.get("instruction") or "",
            tools=resolved_tools,
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
    # Appended, not merged into the caller-provided globalInstruction — this is the ONLY
    # place a registry MCP toolset's tools-allow-list can be enforced (see
    # _mcp_tool_filter_instruction's own comment: get_mcp_toolset has no construction-time
    # filter parameter in the installed google-adk version, confirmed 2026-09-07).
    naming_rule += mcp_tool_filter_instructions

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
        # Per-user tools are UNAFFECTED by this branch: the caller arrives through
        # `tool_context` on the tool's own signature (see _bind_caller), not through an
        # Agent-level callback, so it survives an adk build too old for these kwargs.
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
    # Full-tenant-cutover Dataverse tables migrated to Cloud SQL (_build_cloudsql_tool) —
    # Postgres has no HTTP data plane, so a real client + the Cloud SQL Connector are a
    # genuine, deliberate dependency here, not an oversight (see that function's module
    # comment). Added only when such a tool is present, same minimal-container discipline
    # as the SharePoint/Drive document libraries above.
    if spec.get("cloudSqlTools"):
        requirements += ["pg8000", "cloud-sql-python-connector[pg8000]"]
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
        # Nothing may have created the caller ContextVar before this point -- it would
        # join the pickle graph and turn deployment into a silent low-code fallback.
        _assert_caller_channel_unarmed()
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
        #
        # single_grounding_tool is special-cased to the literal name "discovery_engine_search"
        # instead of introspecting it like every other tool. Root cause (confirmed live
        # 2026-08-24 — WorkMate and Migrate Advisor, both single-knowledge-source agents,
        # both flagged "wrong_agent_tools" while actually working correctly): a lone
        # VertexAiSearchTool is a raw, un-wrapped object at THIS point in the process, so its
        # own __name__/name attribute is whatever ADK's class default is — but Gemini's
        # backend auto-wraps it into a DiscoveryEngineSearchTool at QUERY time, which
        # hardcodes its function name to "discovery_engine_search" (see the module comment
        # above _sanitize_tool_name for the upstream source of that hardcoding). Reporting
        # the pre-wrap name here hands verification a ground truth that the model can never
        # actually match, so every single-store agent failed verification by definition, not
        # by chance — this was never a rare race, it fired on every single-knowledge-source
        # deploy.
        built_tool_names = []
        for _t in tools:
            if _t is single_grounding_tool:
                built_tool_names.append("discovery_engine_search")
                continue
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
