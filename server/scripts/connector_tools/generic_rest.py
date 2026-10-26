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

        # Bounded, declarative pagination — follows ONLY the field named in the catalog's
        # `pagination` metadata (e.g. Microsoft Graph's `@odata.nextLink`), never auto-detected
        # by shape. Two safety rules that are not optional:
        #   1. A continuation link is only ever followed to the SAME host as the original
        #      request, over https. A vendor response naming a different host is refused, not
        #      followed — an unvalidated redirect carrying a live Authorization header is
        #      exactly how a credential leaks to an unintended destination.
        #   2. A failure on page 2+ (network error, non-200, bad JSON) stops pagination and
        #      returns what was ALREADY fetched, with a note saying why it stopped — never
        #      silently discarded, and never thrown away in favor of nothing.
        MAX_PAGINATION_PAGES = 10

        def _follow_pagination(first_body, first_url, headers):
            """Returns (merged_body, pages_fetched, stop_reason_or_None)."""
            pagination = op.get("pagination")
            result_path = op.get("resultPath")
            if not pagination or method != "GET" or not isinstance(first_body, dict):
                return first_body, 1, None
            field = pagination.get("field")
            if not field or not result_path:
                return first_body, 1, None
            items = first_body.get(result_path)
            if not isinstance(items, list):
                # Nothing list-shaped to merge into — a single object response with a stray
                # next-link field is left exactly as the vendor sent it.
                return first_body, 1, None

            original_host = urllib.parse.urlparse(first_url).netloc.lower()
            merged = list(items)
            body = first_body
            pages = 1
            while pages < MAX_PAGINATION_PAGES:
                next_url = body.get(field)
                if not next_url or not isinstance(next_url, str):
                    break
                parsed_next = urllib.parse.urlparse(next_url)
                if parsed_next.scheme != "https" or parsed_next.netloc.lower() != original_host:
                    return (
                        {result_path: merged},
                        pages,
                        "stopped following pagination: the next-page link pointed to "
                        + (parsed_next.netloc or "an unrecognizable address")
                        + ", not the original host (" + original_host + ") — refused rather than followed.",
                    )
                try:
                    next_req = urllib.request.Request(next_url, headers=dict(headers), method="GET")
                    with urllib.request.urlopen(next_req, timeout=30) as resp:
                        body = _json.loads(resp.read().decode("utf-8"))
                except Exception as e:  # noqa: BLE001
                    return (
                        {result_path: merged},
                        pages,
                        "stopped following pagination after page " + str(pages) + ": " + str(e),
                    )
                pages += 1
                page_items = body.get(result_path)
                if isinstance(page_items, list):
                    merged.extend(page_items)
                if not isinstance(body, dict) or not body.get(field):
                    break

            final = dict(body) if isinstance(body, dict) else {}
            final.pop(field, None)
            final[result_path] = merged
            stop_reason = (
                "stopped at the " + str(MAX_PAGINATION_PAGES) + "-page limit; more results may exist"
                if pages >= MAX_PAGINATION_PAGES and isinstance(body, dict) and body.get(field)
                else None
            )
            return final, pages, stop_reason

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

            # Resolved here, not earlier: the caller headers depend on the operation's own
            # URL, which is only complete once its context has been substituted.
            try:
                req_headers.update(_caller_headers(url, header))
            except Exception as e:  # noqa: BLE001
                # Fail the CALL, never fall back to the app identity. An unresolvable caller
                # served the application's view would answer one person's question with
                # everybody's data, and nothing on screen would say so.
                return {"error": str(e)}
            data = None
            if body_val is not None and method in ("POST", "PUT", "PATCH"):
                if isinstance(body_val, str) and "Content-Type" in headers:
                    # The operation declared its OWN Content-Type via a header-typed parameter
                    # (e.g. "text/csv", "text/plain") -- that means the body is the raw content
                    # itself, not a JSON envelope to wrap it in. Forcing application/json here
                    # unconditionally used to silently mislabel a real file's content on every
                    # such call, permanently -- not just for Drive, for any future operation
                    # shaped this way. Respect the declared type instead.
                    data = body_val.encode("utf-8")
                else:
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
                    parsed, pages_fetched, pagination_note = _follow_pagination(parsed, url, req_headers)
                    result = {"status": resp.status, "body": parsed}
                    if pages_fetched > 1:
                        result["pagesFetched"] = pages_fetched
                    if pagination_note:
                        result["paginationNote"] = pagination_note
                    return _capped(result, narrowing)
            except Exception as e:  # noqa: BLE001
                # Quote the failure. A vague error invites the model to narrate a
                # plausible answer instead of reporting that it could not look.
                try:
                    detail = e.read().decode("utf-8")[:500]  # type: ignore[attr-defined]
                except Exception:  # noqa: BLE001
                    detail = str(e)
                return {"error": conn_name + " " + op_id + " failed: " + detail}

        # ── Multi-call operations ("chain") ───────────────────────────────────────────
        #
        # A real vendor operation that is not one HTTP call -- resolving "Reports/2026/
        # file.csv" to a file id (Drive has no path lookup, only name-within-parent search,
        # one segment at a time), or creating a file WITH content (create the metadata row,
        # THEN upload bytes to the id it returned). Declared as data (BoundOperation.chain /
        # operationBinding.ts's ChainStep), executed generically here -- nothing below is
        # specific to Drive or to any one connector.
        def _extract_chain_value(body, path):
            """Dot-path extraction (numeric segments index a list). None if any segment is
            missing -- callers decide what that means (not-found vs. a real error)."""
            cur = body
            for seg in (path or "").split("."):
                if seg == "":
                    continue
                if isinstance(cur, list):
                    try:
                        idx = int(seg)
                    except ValueError:
                        return None
                    cur = cur[idx] if 0 <= idx < len(cur) else None
                elif isinstance(cur, dict):
                    cur = cur.get(seg)
                else:
                    return None
                if cur is None:
                    return None
            return cur

        def _extract_header_value(items, header_name):
            """Finds the entry whose `name` matches `header_name` (case-insensitive) in a
            `[{name, value}, ...]`-shaped list (e.g. Gmail's MIME `payload.headers`) and
            returns its `value`, or None."""
            if not isinstance(items, list):
                return None
            want = (header_name or "").lower()
            for item in items:
                if isinstance(item, dict) and str(item.get("name", "")).lower() == want:
                    return item.get("value")
            return None

        def _build_mime_message(spec: dict, values: dict) -> bytes:
            """Assembles a real RFC 2822 message from `spec` (ChainStep.mimeMessage),
            substituting {placeholders} the same way a URL template does. Returns the raw
            (unencoded) message bytes -- the caller base64url-encodes it."""
            def fill(s):
                out = str(s or "")
                for k, v in values.items():
                    out = out.replace("{" + k + "}", str(v))
                return out

            lines = []
            if spec.get("to"):
                lines.append("To: " + fill(spec["to"]))
            if spec.get("cc"):
                lines.append("Cc: " + fill(spec["cc"]))
            if spec.get("subject"):
                lines.append("Subject: " + fill(spec["subject"]))
            if spec.get("inReplyTo"):
                lines.append("In-Reply-To: " + fill(spec["inReplyTo"]))
            if spec.get("references"):
                lines.append("References: " + fill(spec["references"]))
            lines.append("Content-Type: " + fill(spec.get("contentType") or "text/plain; charset=UTF-8"))
            lines.append("MIME-Version: 1.0")
            lines.append("")  # blank line separates headers from the body
            lines.append(fill(spec.get("body") or ""))
            return ("\r\n".join(lines)).encode("utf-8")

        def _invoke_chain(**kwargs) -> dict:
            values: dict = {}
            for name, meta in fixed.items():
                values[name] = str(meta.get("value"))
            for pn, a in unique_args:
                val = kwargs.get(pn)
                if val not in (None, "", 0, False):
                    values[a["name"]] = str(val)
            try:
                for c in ctx_required:
                    values[c] = _context(c, ctx_values)
            except Exception as e:  # noqa: BLE001
                return {"error": str(e)}
            # {callerEmail} -- the real Google identity this call is already running as
            # (invoker: whoever is asking; maker: the connector's configured impersonate_email)
            # -- available to any step that needs to find "me" in a fetched list (e.g.
            # matching my own entry in a Calendar event's attendees to RSVP correctly).
            # Best-effort: a step that references {callerEmail} without a resolvable one gets
            # a literal empty match, which simply will not find anyone -- never a crash.
            try:
                values["callerEmail"] = (
                    (caller() if (conn.get("perUser") and callable(caller)) else None)
                    or secret("impersonate_email")
                )
            except Exception:  # noqa: BLE001
                values.setdefault("callerEmail", "")

            def _unresolved_names(s: str):
                """Any `{word}` still left after substitution -- same check `_invoke`'s
                single-call path already does for its URL. A step whose template names an
                argument the model never supplied (optional, or forgotten) must refuse
                clearly, never silently send the literal `{name}` text as real request
                data -- that reads as a working call that quietly corrupts the record."""
                return _re.findall(r"\{(\w+)\}", s)

            def _fill_url(tpl: str, extra: dict) -> str:
                merged = dict(values)
                merged.update(extra)
                out = tpl
                for k, v in merged.items():
                    out = out.replace("{" + k + "}", urllib.parse.quote(str(v), safe=""))
                return out

            def _fill_template(node, ctx: dict):
                """Recursively substitutes {placeholders} into a JSON-shaped template's
                STRING values -- a template's own structure (keys, arrays, numbers, booleans)
                is never altered, just like a URL template's non-placeholder characters never
                are. A string that is EXACTLY one placeholder (e.g. "{attendees}") and whose
                bound value is NOT itself a string splices that raw value in directly instead
                of stringifying it -- needed to carry a whole fetched-and-modified list/object
                through to a later step's body untouched (see `updateListEntry` below)."""
                if isinstance(node, str):
                    if node.startswith("{") and node.endswith("}") and node.count("{") == 1:
                        key = node[1:-1]
                        if key in ctx and not isinstance(ctx[key], str):
                            return ctx[key]
                    out = node
                    for k, v in ctx.items():
                        out = out.replace("{" + k + "}", str(v))
                    return out
                if isinstance(node, list):
                    return [_fill_template(n, ctx) for n in node]
                if isinstance(node, dict):
                    return {k: _fill_template(v, ctx) for k, v in node.items()}
                return node

            def _step_body(step: dict):
                """(body_bytes, content_type) for this step, or (None, None) if it has no
                body at all -- a plain GET/DELETE step, the normal case."""
                if step.get("mimeMessage") is not None:
                    import base64 as _base64

                    mime_bytes = _build_mime_message(step["mimeMessage"], values)
                    encoded = _base64.urlsafe_b64encode(mime_bytes).decode("ascii")
                    # Dot-path, not a flat key only -- Gmail's drafts.create needs the encoded
                    # message NESTED as {"message": {"raw": "..."}}, not a top-level "raw".
                    raw_path = (step["mimeMessage"].get("rawField") or "raw").split(".")
                    envelope = dict(_fill_template(step.get("bodyTemplate") or {}, values))
                    node = envelope
                    for part in raw_path[:-1]:
                        node = node.setdefault(part, {})
                    node[raw_path[-1]] = encoded
                    return _json.dumps(envelope).encode("utf-8"), "application/json"
                if step.get("bodyTemplate") is not None:
                    filled = _fill_template(step["bodyTemplate"], values)
                    return _json.dumps(filled).encode("utf-8"), "application/json"
                if step.get("bodyFromParam"):
                    raw = values.get(step["bodyFromParam"], "")
                    ct_param = step.get("bodyContentTypeParam")
                    content_type = values.get(ct_param, "") if ct_param else ""
                    return raw.encode("utf-8"), (content_type or "application/octet-stream")
                return None, None

            def _call(method_s: str, url: str, body_bytes=None, content_type=None):
                """Raises on either a refused caller (impersonation) or a real request
                failure -- the two are kept visibly separate at each call site below,
                same discipline as the single-call `_invoke` above."""
                try:
                    header = _aad_header() if op.get("auth") == "aad-token" else auth_header(fill)
                except Exception as e:  # noqa: BLE001
                    raise RuntimeError("auth failed (" + str(op.get("auth") or auth_kind) + "): " + str(e)) from e
                headers = {"Accept": "application/json"}
                if header:
                    headers["Authorization"] = header
                headers.update(_caller_headers(url, header))  # raises if this caller cannot be named
                if body_bytes is not None and content_type:
                    headers["Content-Type"] = content_type
                req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method_s)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    raw = resp.read().decode("utf-8")
                    return _json.loads(raw) if raw.strip() else {}

            steps = op.get("chain") or []
            last_body: dict = {}
            for step in steps:
                # A LOCAL TRANSFORM, not an HTTP call -- updates ONE entry in a list a prior
                # step already fetched (matched on a field, e.g. "email"), binding the WHOLE
                # modified list for a later step's bodyTemplate to send back. Exists because
                # a vendor PATCH that takes an array field (e.g. Calendar's `attendees`)
                # typically REPLACES it wholesale -- sending back just one entry would erase
                # everyone else invited, so the only correct way to change "my own" response
                # is fetch-the-full-list, change my one entry, send the whole list back.
                upd = step.get("updateListEntry")
                if upd:
                    source_list = values.get(upd["listVar"])
                    if not isinstance(source_list, list):
                        return {"error": "'" + upd["listVar"] + "' is not a list — cannot update an entry in it"}
                    match_value = _fill_template(upd["matchValue"], values)
                    set_value = _fill_template(upd["setValue"], values)
                    new_list = []
                    found = False
                    for entry in source_list:
                        if (
                            isinstance(entry, dict)
                            and str(entry.get(upd["matchField"], "")).lower() == str(match_value).lower()
                        ):
                            entry = dict(entry)
                            entry[upd["setField"]] = set_value
                            found = True
                        new_list.append(entry)
                    if not found:
                        return {
                            "error": "no entry in '" + upd["listVar"] + "' has " + upd["matchField"]
                            + " = '" + str(match_value) + "' — nothing to update"
                        }
                    values[upd["bindAs"]] = new_list
                    continue

                method_s = (step.get("method") or "GET").upper()
                repeat_param = step.get("repeatOverParam")
                if repeat_param:
                    raw_val = values.get(repeat_param, "")
                    segments = [s for s in str(raw_val).strip("/").split("/") if s]
                    if not segments:
                        return {"error": "'" + repeat_param + "' must name at least one segment"}
                    bind_as = step.get("bindAs") or "prev"
                    noun = step.get("itemNoun") or "item"
                    current = step.get("initialValue", "")
                    for i, seg in enumerate(segments):
                        url = _fill_url(step["urlTemplate"], {bind_as: current, "segment": seg})
                        missing_in_url = _unresolved_names(url)
                        if missing_in_url:
                            return {"error": "missing required value(s) for " + ", ".join(missing_in_url)}
                        try:
                            body = _call(method_s, url)
                        except Exception as e:  # noqa: BLE001
                            try:
                                detail = e.read().decode("utf-8")[:300]  # type: ignore[attr-defined]
                            except Exception:  # noqa: BLE001
                                detail = str(e)
                            return {"error": "could not resolve '" + seg + "': " + detail}
                        matches = _extract_chain_value(body, step.get("extractPath") or "")
                        if not isinstance(matches, list):
                            matches = [] if matches is None else [matches]
                        seen_so_far = "/".join(segments[:i]) or "root"
                        if len(matches) == 0:
                            return {"error": "'" + seg + "' not found under '" + seen_so_far + "'"}
                        if len(matches) > 1:
                            return {
                                "error": "'" + seg + "' is ambiguous under '" + seen_so_far
                                + "' -- " + str(len(matches)) + " " + noun
                                + "s share that name; narrow the path."
                            }
                        item = matches[0]
                        id_field = step.get("itemIdField")
                        current = item.get(id_field) if id_field and isinstance(item, dict) else item
                        if current is None:
                            return {"error": "could not read '" + str(id_field) + "' for '" + seg + "'"}
                    values[bind_as] = current
                    continue

                url = _fill_url(step["urlTemplate"], {})
                missing_in_url = _unresolved_names(url)
                if missing_in_url:
                    return {"error": "missing required value(s) for " + ", ".join(missing_in_url)}
                body_bytes, content_type = _step_body(step)
                if body_bytes is not None and (step.get("bodyTemplate") is not None or step.get("mimeMessage") is not None):
                    missing_in_body = _unresolved_names(body_bytes.decode("utf-8", errors="ignore"))
                    if missing_in_body:
                        return {"error": "missing required value(s) for " + ", ".join(missing_in_body)}
                try:
                    body = _call(method_s, url, body_bytes, content_type)
                except Exception as e:  # noqa: BLE001
                    try:
                        detail = e.read().decode("utf-8")[:500]  # type: ignore[attr-defined]
                    except Exception:  # noqa: BLE001
                        detail = str(e)
                    return {"error": conn_name + " " + op_id + " failed: " + detail}
                last_body = body
                bind_as = step.get("bindAs")
                if bind_as:
                    extracted = _extract_chain_value(body, step.get("extractPath") or "")
                    if extracted is None:
                        return {"error": "could not extract '" + str(step.get("extractPath")) + "' from the response"}
                    values[bind_as] = extracted
                for spec in (step.get("extracts") or []):
                    raw_val = _extract_chain_value(body, spec.get("path") or "")
                    if spec.get("headerName"):
                        raw_val = _extract_header_value(raw_val, spec["headerName"])
                    if raw_val is None:
                        return {"error": "could not extract '" + str(spec.get("headerName") or spec.get("path")) + "' from the response"}
                    values[spec["bindAs"]] = raw_val

            return _capped({"status": 200, "body": last_body})

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
        if op.get("chain"):
            src = "def " + fn_name + "(" + sig + ") -> dict:\n    return _invoke_chain(" + call_args + ")\n"
            ns = {"_invoke_chain": _invoke_chain}
        else:
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
        if kind_ == "google-dwd-subject":
            # NOT unimplemented -- already finished, just somewhere else. For Google connectors
            # the caller is baked into the ACCESS TOKEN itself at mint time (`_mint_token` in
            # adk_deploy.py, which already resolved `_caller_var()` into a DWD subject before
            # `auth` -- the header this function receives -- was ever built). There is nothing
            # left for a HEADER to add on top of that, so unlike the "no mechanism" case below,
            # returning {} here is correct, not a silent skip. Confirmed live 2026-10-22: this
            # exact raise was firing for an invoker-mode Drive tool whose token mint had already
            # succeeded as the right person, because this function did not yet know that
            # "google-dwd-subject" means "handled, not missing."
            return {}
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
        # TWO LOOKUPS, NOT ONE OR-ED FILTER. The local-part clause exists because the
        # destination directory and the source Dataverse are usually different domains
        # (alex@newco.com and alex@oldco.co being one person is the normal case). OR-ing it
        # with the exact clause made the fallback compete with the answer: erik@filefuze.co
        # is one specific account AND a prefix match for erik@voohalu.co, so a caller whose
        # address was sitting in the table verbatim was refused as ambiguous. Measured live
        # 2026-10-14. An exact address is not a guess and nothing can out-rank it; the
        # fallback is only for when there is no exact match to rank.
        local = who.split("@")[0].replace("'", "''")
        safe = who.replace("'", "''")

        def _lookup(flt):
            url = (base_url + "/systemusers?$select=systemuserid,internalemailaddress&$top=2&$filter="
                   + urllib.parse.quote(flt, safe=""))
            req = urllib.request.Request(url, headers={
                "Authorization": auth, "Accept": "application/json",
                "OData-MaxVersion": "4.0", "OData-Version": "4.0",
            })
            with urllib.request.urlopen(req, timeout=20) as resp:
                return (_json.loads(resp.read().decode("utf-8")) or {}).get("value") or []

        rows = _lookup(
            "internalemailaddress eq '" + safe + "'"
            " or domainname eq '" + safe + "'"
        )
        exact = bool(rows)
        if not rows:
            rows = _lookup("startswith(internalemailaddress,'" + local + "@')")
        if not rows:
            raise RuntimeError(
                (conn.get("name") or "this tool") + ": no account for " + who
                + " exists in this environment, so it cannot run as them."
            )
        if len(rows) > 1:
            # Still ambiguous after the split. Two accounts carrying the SAME address is a
            # directory problem; two sharing a local part means the fallback cannot tell them
            # apart. Either way, picking one would act as a person chosen by sort order.
            raise RuntimeError(
                (conn.get("name") or "this tool") + ": " + who
                + (" matches more than one account with that exact address"
                   if exact else
                   " has no account with that exact address, and more than one account"
                   " shares its name before the @")
                + " in this environment; cannot choose."
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
            headers["Authorization"] = header
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
