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
    # Almost every connector sends its credential as `Authorization`, but a few vendors
    # (BigCommerce's X-Auth-Token, Pivotal Tracker's X-TrackerToken, VirusTotal's x-apikey)
    # use a different header name for the exact same "one credential value" shape — not a
    # different auth KIND, just a different header key. Defaulting to Authorization keeps
    # every existing connector's behavior identical.
    auth_header_name = conn.get("authHeaderName") or "Authorization"

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

        def _one_step(step, captured, kwargs) -> dict:
            m = step.get("method") or method
            try:
                header = _aad_header() if op.get("auth") == "aad-token" else auth_header(fill)
            except Exception as e:  # noqa: BLE001
                return {"error": "auth failed (" + str(op.get("auth") or auth_kind) + "): " + str(e)}

            path_params, query, headers = {}, {}, {}
            body_val = None

            url = step.get("urlTemplate") or url_tpl
            try:
                for c in ctx_required:
                    url = url.replace("{" + c + "}", _context(c, ctx_values))
            except Exception as e:  # noqa: BLE001
                return {"error": str(e)}

            def _place(name, val):
                """Put {name} into the URL when the mapping put the placeholder there.

                A map entry may interpolate a model argument INSIDE another parameter's
                template: Drive's path lookup builds q="name = '{path}' and trashed =
                false", so `path` is declared `in: query` yet its placeholder lives in the
                URL. Routing it only by its declared `in` left `{path}` literal in the URL
                AND sent a stray `path=` parameter, so every ByPath operation failed at the
                FIRST step with "missing required value(s) for path".

                Found by executing it, not by verifying it. The structural check sees a
                placeholder filled by a declared argument and is satisfied -- the name was
                right, only the mechanics were wrong, and no offline check can see that.
                """
                nonlocal url
                token = "{" + str(name) + "}"
                if token not in url:
                    return False
                url = url.replace(token, urllib.parse.quote(str(val), safe=""))
                return True

            for name, meta in fixed.items():
                where = meta.get("in") or "query"
                val = meta.get("value")
                if where != "body" and _place(name, val):
                    continue
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
                if where != "body" and _place(a["name"], val):
                    continue
                if where == "path":
                    path_params[a["name"]] = val
                elif where == "header":
                    headers[a["name"]] = str(val)
                elif where == "body":
                    body_val = val
                else:
                    query[a["name"]] = val

            for name, val in path_params.items():
                url = url.replace("{" + name + "}", urllib.parse.quote(str(val), safe=""))
            for _cv, _val in captured.items():
                url = url.replace("{$" + _cv + "}", urllib.parse.quote(str(_val), safe=""))
                url = url.replace("{$" + _cv + "}", urllib.parse.quote(str(_val), safe=""))
            missing = _re.findall(r"\{\$?(\w+)\}", url)
            if missing:
                return {"error": "missing required value(s) for " + ", ".join(missing)}
            if query:
                # A MAPPED operation's url_tpl already carries the query the mapping fixed
                # (`...files/{id}?supportsAllDrives=true`), so a second "?" here would build
                # a URL no server parses. Join on "&" once one is present.
                url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(query)

            req_headers = {"Accept": "application/json"}
            req_headers.update(headers)
            if header:
                req_headers[auth_header_name] = header

            # Resolved here, not earlier: the caller headers depend on the operation's own
            # URL, which is only complete once its context has been substituted.
            try:
                req_headers.update(_caller_headers(url, header))
            except Exception as e:  # noqa: BLE001
                # Fail the CALL, never fall back to the app identity. An unresolvable caller
                # served the application's view would answer one person's question with
                # everybody's data, and nothing on screen would say so.
                return {"error": str(e)}
            # A MAPPED operation may build its body rather than forward an argument: Sheets
            # appends a list of rows where the connector sends one object, Drive's copy wants
            # a parent ARRAY where the connector passes one destination. The template's
            # placeholders are replaced by the JSON ENCODING of each argument — which is why
            # they are written unquoted — so the result is valid JSON whatever the type.
            body_tpl = step.get("bodyTemplate")
            forward_from = step.get("forwardBodyFrom")
            if body_tpl or forward_from:
                arg_values = {n: meta.get("value") for n, meta in fixed.items()}
                for pn, a in unique_args:
                    v = kwargs.get(pn)
                    if v is not None:
                        arg_values[a["name"]] = v
                # `{$name}` is a value an earlier step captured, never something the model
                # supplied. Keyed with the $ so the two can never collide.
                for _cv, _val in captured.items():
                    arg_values["$" + _cv] = _val
            if body_tpl:
                body_val = _re.sub(
                    r"\{(\$?\w+)\}",
                    lambda mo: _json.dumps(arg_values.get(mo.group(1))),
                    body_tpl,
                )
            elif forward_from:
                # Content upload: the body is the file's BYTES, so it goes out exactly as
                # given. JSON-encoding it here would upload the quoted, escaped text of the
                # file rather than the file.
                body_val = arg_values.get(forward_from)

            data = None
            if body_val is not None and m in ("POST", "PUT", "PATCH"):
                payload = body_val if isinstance(body_val, str) else _json.dumps(body_val)
                data = payload.encode("utf-8")
                req_headers["Content-Type"] = (
                    step.get("contentType") or "application/octet-stream"
                ) if forward_from else "application/json"
            req = urllib.request.Request(url, data=data, headers=req_headers, method=m)
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    payload_bytes = resp.read()
                    try:
                        raw = payload_bytes.decode("utf-8")
                    except UnicodeDecodeError:
                        # NOT TEXT. A file's bytes -- a PDF from export, an image, an
                        # archive -- are a normal answer here, and this used to assume
                        # otherwise: every binary download died with "utf-8 codec can't
                        # decode byte", after a successful fetch. Decoding with
                        # errors="replace" would be worse, handing back mojibake nothing
                        # downstream could tell from real content.
                        import base64 as _b64

                        ctype = ""
                        try:
                            ctype = resp.headers.get("Content-Type", "") or ""
                        except Exception:  # noqa: BLE001
                            pass
                        encoded = _b64.b64encode(payload_bytes).decode("ascii")
                        if len(encoded) > RESULT_CHAR_BUDGET:
                            # Truncating base64 yields a string that does not decode, so the
                            # content is omitted and said to be omitted -- the one option
                            # that cannot be mistaken for the file itself.
                            return {
                                "status": resp.status,
                                "contentType": ctype,
                                "bytes": len(payload_bytes),
                                "note": (
                                    "Binary content of " + str(len(payload_bytes))
                                    + " bytes was returned and is too large to include. It is "
                                    "OMITTED, not truncated: a partial base64 string would not "
                                    "decode. Do not describe the contents."
                                ),
                            }
                        return {
                            "status": resp.status,
                            "contentType": ctype,
                            "bytes": len(payload_bytes),
                            "encoding": "base64",
                            "body": encoded,
                        }
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
                failure = {"error": conn_name + " " + op_id + " failed: " + detail}
                # The status has to survive the failure: it is what selects a fallback, and
                # without it the only alternative is retrying on ANY error -- which is how a
                # narrow "this resource needs the other call" becomes a blanket retry that
                # hides real faults.
                code = getattr(e, "code", None)
                if isinstance(code, int):
                    failure["status"] = code
                return failure

        def _dig(obj, path: str):
            """Read `files[0].id` out of a parsed response.

            Deliberately tiny: a capture path addresses one value in a document the VENDOR
            defines, and anything needing more expressiveness than this is a mapping that
            should not have been written. Returns None rather than raising, so a shape that
            does not match is reported as a missing value by the caller instead of killing
            the tool.
            """
            cur = obj
            for part in path.split("."):
                key, idxs = part, _re.findall(r"\[(\d+)\]", part)
                if idxs:
                    key = part[: part.index("[")]
                if key:
                    if not isinstance(cur, dict):
                        return None
                    cur = cur.get(key)
                for i in idxs:
                    if not isinstance(cur, list) or int(i) >= len(cur):
                        return None
                    cur = cur[int(i)]
            return cur

        def _invoke(**kwargs) -> dict:
            """One operation, which may be more than one vendor call.

            Some Power Platform operations have no single vendor call behind them: Drive has
            no path lookup, so "get the file at /a/b.txt" is a search followed by a fetch.
            The sequence lives in the MAPPING as data; this only fills templates, reads
            captured values out of responses, and stops at the first failure — it knows
            nothing about Drive or Sheets.
            """
            steps = op.get("steps")
            if not steps:
                return _one_step(op, {}, kwargs)
            captured: dict = {}
            result: dict = {}
            for n, s in enumerate(steps):
                result = _one_step(s, captured, kwargs)
                if "error" in result:
                    # A mapping may name ONE alternative call for a refusal that is about
                    # what the resource is rather than about the request -- Drive answers
                    # 403 for `alt=media` on a Google Doc, which has no bytes to return and
                    # must be exported instead. Only the declared statuses select it.
                    alt = s.get("fallback") or {}
                    if alt.get("step") and result.get("status") in (alt.get("whenStatus") or []):
                        result = _one_step(alt["step"], captured, kwargs)
                    if "error" in result:
                        return {"error": "step " + str(n + 1) + " of " + str(len(steps)) + ": " + str(result["error"])}
                for var, path in (s.get("capture") or {}).items():
                    val = _dig(result.get("body"), path)
                    if val is None:
                        # Stop rather than carry a hole forward. A later step would fill
                        # {$var} with "None" and fetch a resource that does not exist, or
                        # worse, one that does.
                        return {"error": conn_name + " " + op_id + ": step " + str(n + 1)
                                + " returned no value at '" + path + "' (nothing matched)"}
                    captured[var] = val
            return result

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

        # ── What the model is TOLD about each argument ──────────────────────────────
        #
        # ADK turns this docstring into the FunctionDeclaration the model sees, so every
        # fact the swagger carries about an argument has to arrive here or it may as well
        # not have been captured. Before the index carried descriptions, this loop fell
        # through to `a.get("name")` on essentially every argument and the model was shown
        # `$filter: $filter` -- a name, repeated, and nothing about what belongs in it.
        #
        # `default` is DESCRIBED, never applied. The generated signature keeps its empty
        # default (see the signature loop above) because sending the vendor's default would
        # make the migrated tool send a value the source agent did not send.
        def _schema_lines(schema, pad):
            """Field names of a body schema, two levels deep, as docstring lines.

            Two levels is the readable limit: the model needs to know WHICH fields a body
            takes and which are mandatory, and a full type expansion crowds out the rest of
            the tool list. The deeper levels still travel in the spec for anything else that
            wants them.
            """
            if not isinstance(schema, dict):
                return ""
            out = ""
            props = schema.get("properties") or {}
            req = set(schema.get("required") or [])
            for fname, fschema in list(props.items())[:20]:
                fschema = fschema if isinstance(fschema, dict) else {}
                ftype = fschema.get("type") or "any"
                line = pad + fname + ": " + str(ftype)
                if fname in req:
                    line += " (required)"
                fdesc = fschema.get("description")
                if fdesc:
                    line += " - " + str(fdesc).replace("\n", " ")[:120]
                out += line + "\n"
                sub = fschema.get("properties") or {}
                if sub and len(pad) < 12:
                    for sname, sschema in list(sub.items())[:10]:
                        sschema = sschema if isinstance(sschema, dict) else {}
                        out += pad + "    " + sname + ": " + str(sschema.get("type") or "any") + "\n"
            if len(props) > 20:
                out += pad + "... and " + str(len(props) - 20) + " more field(s)\n"
            # Honesty, same rule as everywhere else in this pipeline: a shape we cut short
            # is announced as partial rather than presented as the whole thing, so the model
            # does not report "that field does not exist" about a field we simply dropped.
            if schema.get("truncated"):
                out += pad + "(partial shape - the vendor's schema is larger than shown)\n"
            return out

        arg_doc = ""
        for pn, a in unique_args:
            arg_doc += "    " + pn + ": " + str(a.get("description") or a.get("name") or "")
            if a.get("required"):
                arg_doc += " (required)"
            choices = a.get("enum") or []
            if choices:
                arg_doc += " [one of: " + ", ".join(str(c) for c in choices[:20]) + "]"
            if a.get("default") is not None:
                arg_doc += " [omit to use the vendor default: " + str(a.get("default")) + "]"
            arg_doc += "\n"
            arg_doc += _schema_lines(a.get("schema"), "        ")
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

    def _caller_headers(url: str, auth: str) -> dict:
        """Caller headers for ANY request this connector makes, or raise.

        WHY THIS EXISTS AS A SEPARATE LAYER. Impersonation has to be applied where requests
        are SENT, not per tool: a connector with no mapped swagger operations falls back to
        `call_external_api`, which takes an arbitrary path, method and body. Wiring the caller
        into the mapped-operation path alone left that fallback running every call -- writes
        included -- as the application, with nothing on screen to say so.

        An UNSUPPORTED resolve kind raises. Returning {} would mean "no impersonation
        available" and "impersonation not needed" look identical at the send site, which is
        how a per-user connector ends up quietly acting as the app. Jira, Confluence and
        HubSpot have no impersonation mechanism at all -- an API token IS one account -- so
        they must never be marked per-user in the first place; if one ever is, this refuses
        rather than pretending.
        """
        if not conn.get("perUser") or conn.get("perUserMode") != "impersonate":
            return {}
        kind_ = conn.get("impersonationResolve") or "dataverse-systemuser"
        if kind_ == "dataverse-systemuser":
            # The environment's API root is only knowable from the resolved URL, and the
            # systemusers lookup must run against the SAME environment as the call.
            api_root = url.split("/api/data/")[0] + "/api/data/v9.2"
            return _impersonation_headers(api_root, auth)
        raise RuntimeError(
            (conn.get("name") or "this tool")
            + ": ran under each user's own credentials in Copilot Studio, but this connector"
            + " has no way to act as another person ("
            + str(kind_)
            + "), so it will not run as anyone."
        )

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

        # The operator's own mapping first — see outlook.py for why a local-part guess is
        # not safe here either. This turns the destination identity Gemini gives us into the
        # source address the systemusers lookup below can actually match on.
        who = (conn.get("callerIdentityMap") or {}).get(who.lower(), who)

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
            headers[auth_header_name] = header
        url = f"{base}/{path.lstrip('/')}"
        # This tool accepts any path, method and body, so it is a WRITE path as much as a
        # read one. Without this it ran as the application for every caller.
        try:
            headers.update(_caller_headers(url, header))
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}
        data = body.encode("utf-8") if body else None
        if data:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
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
