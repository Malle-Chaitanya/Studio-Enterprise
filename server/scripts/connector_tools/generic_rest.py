"""Generic REST connector fallback: bound per-operation tools when the server
captured the source agent's actual swagger operations, else a single generic
call_external_api tool driven by the registry's base-URL/auth templates.
See connector_tools/confluence.py's module docstring for the shared
build_tools contract every connector module in this package follows.
"""

import re  # module-level: used both inside call_external_api and after it's defined,
           # in build_tools' own scope when naming the tool by connector.


def build_tools(conn, secret, mint_token, auth_header, fill, caller=None):
    kind = (conn.get("kind") or conn.get("id") or "").lower()
    base_url_tpl = conn.get("baseUrlTemplate") or ""
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

    # Minted AAD tokens (for bound operations with auth="aad-token") are cached per
    # container for their stated lifetime — see _aad_header below.
    token_cache: dict = {}

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
    # CUSTOMER's environment. Auth reuses `auth_header` above, so there is exactly one
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

            base = secret("base_url").rstrip("/")
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

            The resource is the customer's own org URL, which the server passes as context
            rather than asking an admin to paste a URL we already hold. The registry's
            generic path cannot be reused here because it resolves the scope from a stored
            `org_url` secret that, by design, does not exist for this connector.

            Mints app-only OR as the calling user, depending on `perUser` -- see the note
            below on why substituting one for the other is not a safe simplification.
            """
            import json as _json
            import time
            import urllib.parse
            import urllib.request

            import hashlib

            resource = op.get("aadResource") or ""
            for c in ctx_required:
                resource = resource.replace("{" + c + "}", _context(c, ctx_values))
            resource = resource.rstrip("/")

            # PER-USER vs APP-ONLY. client_credentials authenticates the APPLICATION -- the
            # same identity no matter who asks, and in Dataverse an application user's roles
            # typically span the whole environment. Copilot's `invoker` mode ran the tool as
            # the SIGNED-IN user, whose own security roles decide what they can see. Running
            # a per-user tool app-only would succeed while showing every caller records they
            # were never able to reach, which is the failure this flag exists to prevent.
            per_user = bool(conn.get("perUser"))
            # IMPERSONATION: the app credential is correct here, unchanged. The caller is named
            # on the request itself (see _caller_header below) and the platform applies THAT
            # person's permissions -- so an app-only token is not a leak, it is the mechanism.
            impersonating = per_user and conn.get("perUserMode") == "impersonate"
            # Only the DELEGATED path swaps the credential. Impersonation keeps the app token
            # and names the caller on the request instead, so everything below must treat it
            # as app-only or it will hunt for a per-user secret that by design never exists.
            delegated = per_user and not impersonating
            if delegated and "refresh_token" not in (conn.get("perUserFields") or []):
                raise RuntimeError(
                    (conn.get("name") or "this tool")
                    + ": ran under each user's own credentials in Copilot Studio, and this"
                    " connector has no per-user sign-in, so it cannot run for anyone."
                    " See the migration report's toolCredentials note."
                )

            if delegated:
                # secret() already resolves refresh_token to THIS caller's own entry, and
                # raises a connect-your-account error when they have none.
                refresh_token = secret("refresh_token")
                # Key the cache by the token's digest, never by resource alone: this cache
                # lives for the container's lifetime across every request it serves, so a
                # resource-only key would hand one person's delegated token to the next
                # caller -- and it would look like a cache hit, not a bug. The digest is
                # one-way and changes when the user reconnects, which also retires the
                # stale entry for free.
                cache_key = ("aad:" + resource + ":u:"
                             + hashlib.sha256(refresh_token.encode()).hexdigest()[:16])
            else:
                cache_key = "aad:" + resource

            cached = token_cache.get(cache_key)
            if cached and cached.get("expires_at", 0) > time.time() + 60:
                return "Bearer " + cached["token"]

            if delegated:
                form = {
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": secret("client_id"),
                    "client_secret": secret("client_secret"),
                    # .default returns what this USER already consented to for the resource.
                    "scope": resource + "/.default",
                }
            else:
                form = {
                    "grant_type": "client_credentials",
                    "client_id": secret("client_id"),
                    "client_secret": secret("client_secret"),
                    "scope": resource + "/.default",
                }
            url = "https://login.microsoftonline.com/" + secret("tenant_id") + "/oauth2/v2.0/token"
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

    # ── Impersonation: act as the person asking, using the shared app credential ──────
    #
    # Copilot `invoker` tools ran as the signed-in user. Dataverse can reproduce that exactly:
    # an app-only call carrying MSCRMCallerID is evaluated against the NAMED user's security
    # roles, not the application's. Verified live 2026-08-31 -- the app reads 50 rows, the same
    # call as a role-less user is refused with "They need a role with the prvReadUser privilege".
    #
    # Preferred over a per-user OAuth token because nothing is stored per person: nothing
    # expires, a new joiner works immediately, and the agent keeps working after the migration
    # tool that created it is gone.
    caller_cache: dict = {}

    def _impersonation_headers(base_url: str, auth: str) -> dict:
        """{MSCRMCallerID: <systemuserid>} for the caller, or raise.

        RAISES rather than returning {} when the caller is unknown or has no account in this
        environment. An empty dict would silently fall through to the application identity,
        which sees every record in the environment -- one person's question answered with
        everybody's data, and no error to notice.
        """
        if not conn.get("perUser") or conn.get("perUserMode") != "impersonate":
            return {}
        header = conn.get("impersonationHeader") or "MSCRMCallerID"
        who = (caller() if caller else "") or ""
        if not who:
            raise RuntimeError(
                (conn.get("name") or "this tool")
                + ": runs as whoever is asking, but the caller could not be identified."
            )
        if who in caller_cache:
            return {header: caller_cache[who]}

        import json as _json
        import urllib.parse
        import urllib.request

        # The id is per ENVIRONMENT, so it is resolved here rather than baked in at deploy:
        # a systemuserid from one org is meaningless in another, and someone who joins after
        # the migration would not be in a deploy-time map at all.
        #
        # Matched on the caller's own address first, then on the local part, because the
        # destination directory and the source Dataverse are usually different domains
        # (alex@newco.com and alex@oldco.co being one person is the normal case, not the odd one).
        local = who.split("@")[0].replace("'", "''")
        safe = who.replace("'", "''")
        flt = (
            "internalemailaddress eq '" + safe + "'"
            " or domainname eq '" + safe + "'"
            " or startswith(internalemailaddress,'" + local + "@')"
        )
        url = (base_url + "/systemusers?$select=systemuserid,internalemailaddress&$top=2&$filter="
               + urllib.parse.quote(flt, safe=""))
        req = urllib.request.Request(url, headers={
            "Authorization": auth, "Accept": "application/json",
            "OData-MaxVersion": "4.0", "OData-Version": "4.0",
        })
        with urllib.request.urlopen(req, timeout=20) as resp:
            rows = (_json.loads(resp.read().decode("utf-8")) or {}).get("value") or []
        if not rows:
            raise RuntimeError(
                (conn.get("name") or "this tool") + ": no account for " + who
                + " exists in this environment, so it cannot run as them."
            )
        if len(rows) > 1:
            # Two matches means the local-part fallback was ambiguous. Picking one would act
            # as a person chosen by sort order.
            raise RuntimeError(
                (conn.get("name") or "this tool") + ": " + who
                + " matches more than one account in this environment; cannot choose."
            )
        caller_cache[who] = rows[0]["systemuserid"]
        return {header: caller_cache[who]}

        def _invoke(**kwargs) -> dict:
            try:
                header = _aad_header() if op.get("auth") == "aad-token" else auth_header(fill)
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
            if header:
                req_headers["Authorization"] = header

            # Resolved here, not earlier: the environment's API root is only known once the
            # operation's own URL has had its context substituted, and the systemusers lookup
            # has to run against the SAME environment this call is about.
            try:
                api_root = url.split("/api/data/")[0] + "/api/data/v9.2"
                req_headers.update(_impersonation_headers(api_root, header))
            except Exception as e:  # noqa: BLE001
                # Fail the CALL, never fall back to the app identity. An unresolvable caller
                # served the application's view would answer one person's question with
                # everybody's data, and nothing on screen would say so.
                return {"error": str(e)}
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

    # Name the tool AFTER ITS CONNECTOR. Every generic connector used to return a
    # function literally called `call_external_api`, so an agent with two of them —
    # Jira and HubSpot, which is a normal pairing — sent Gemini two identical
    # FunctionDeclarations and was rejected with "Duplicate function declaration
    # found: call_external_api". Same class of bug as the DiscoveryEngineSearchTool
    # collision documented in adk_deploy.py, and it only appears once a SECOND generic
    # connector is configured, so adding a connector broke agents that previously worked.
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
