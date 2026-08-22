"""HubSpot live tools — named, documented functions instead of the generic REST
fallback.

WHY THIS MODULE EXISTS
----------------------
Every HubSpot connector id previously fell through to connector_tools/generic_rest.py,
i.e. a "call any REST API" tool. That shape is confirmed NOT to work: for Drive and
Confluence the model declined to construct calls for an API it does not know by heart
(live 2026-08-10), and HubSpot is worse, because the operations the customer's agents
use are Independent Publisher connector names whose real endpoints do not match their
titles. 33 staged agents across three HubSpot connector ids depended on that fallback.

FIVE API FACTS, ALL MEASURED ON THE CUSTOMER'S PORTAL (246967746) ON 2026-08-20
------------------------------------------------------------------------------
1. `GetTheDailyApiUsageAndLimitsForAHubspotAccount` does NOT map to any portal-level
   usage endpoint. `/account-info/v3/api-usage/daily`, `/account-info/v1/...`,
   `/integrations/v1/limit/daily` and `/account-info/v3/usage-limits` all 404. Usage is
   reported PER PRIVATE APP: `/account-info/v3/api-usage/daily/private-apps`.
2. That endpoint's `currentUsage` is a LAGGING SNAPSHOT with its own `collectedAt`
   timestamp — it read 0 while the account had demonstrably served calls in the same
   second. Every HubSpot response also carries `X-HubSpot-RateLimit-Daily-Remaining`,
   which is current. Both are reported, labelled, because quoting the stale one as
   "calls used today" is wrong in exactly the way nobody checks.
3. A private app token (`pat-…`) CANNOT be introspected: `/oauth/v1/access-tokens/{t}`
   returns 400 "The access token must have the correct format" — that endpoint is for
   OAuth access tokens only. So the tools cannot tell the agent which scopes it has;
   a missing scope appears as a 403 at inference time and is reported as such.
4. CMS is a DIFFERENT SCOPE FAMILY. `/cms/v3/design-manager/templates` 404s; templates live
   only on the legacy `/content/api/v2/templates`, which needs one of
   design-manager-access / content-editor-access / landingpages-read. The CRM token in use
   has none of them, so `shared_hubspotcms` works only after the customer adds a CMS scope.
   HubSpot also echoes the token back in that 403 body, which is redacted before use.
5. Associations return IDs ONLY (`toObjectId`), never names. An agent answering "which
   contacts work at this company?" with a list of 18-digit numbers is useless, so
   hubspot_list_associations hydrates the ids into names in a second call.

Contract per connector_tools/confluence.py: build_tools(conn, secret, mint_token,
auth_header, fill) -> list of ADK function tools. Every helper is NESTED, because
cloudpickle serialises a nested closure BY VALUE and a module-level function BY
REFERENCE — a module-level helper is not shipped in the Reasoning Engine pickle and
every tool calling it dies at inference with NameError while working locally.

All tools here are READ-ONLY. Nothing creates, updates, deletes or merges a CRM record:
the source agents only ever read, and a write tool nobody asked for is a liability on an
account holding real customer data.
"""

# The object types the CRM tools accept. Restricted deliberately: HubSpot will happily
# 404 on a plural/singular slip ("company" vs "companies"), and the error it returns does
# not say which half was wrong.
OBJECT_TYPES = ("companies", "contacts", "deals", "tickets")

# What to ask for per object type. Without an explicit `properties` list HubSpot returns
# only the internal ids and timestamps — technically a 200, and useless to the model.
DEFAULT_PROPERTIES = {
    "companies": ["name", "domain", "industry", "city", "country", "phone", "website"],
    "contacts": ["email", "firstname", "lastname", "jobtitle", "phone", "company"],
    "deals": ["dealname", "amount", "dealstage", "pipeline", "closedate"],
    "tickets": ["subject", "content", "hs_pipeline_stage", "hs_ticket_priority"],
}

# The SINGULAR of each type, for sentences the user reads. Not `type[:-1]`, which turns
# "companies" into "companie" — live 2026-08-20 the empty-association message read
# "No tickets are linked to that companie in HubSpot." A tool that is right about the data
# and wrong about the English still reads as broken.
SINGULAR = {
    "companies": "company",
    "contacts": "contact",
    "deals": "deal",
    "tickets": "ticket",
}

# The human-facing label for each type, used when hydrating association ids into names.
NAME_PROPERTY = {
    "companies": "name",
    "contacts": "email",
    "deals": "dealname",
    "tickets": "subject",
}


def build_tools(conn, secret, mint_token, auth_header, fill):
    base_url_tpl = conn.get("baseUrlTemplate") or "https://api.hubapi.com"

    # ---- shared helpers ------------------------------------------------------------
    # NESTED, not module-level — see the module docstring. This is the single most
    # expensive mistake available in this file.

    def _request(path, method="GET", body=None):
        """One HubSpot REST call. Returns (parsed, headers, error)."""
        import json as _json
        import urllib.request

        try:
            base = fill(base_url_tpl).rstrip("/")
            header = auth_header(fill)
        except Exception as e:  # noqa: BLE001
            return None, {}, f"auth failed: {e}"
        url = f"{base}{path}" if path.startswith("/") else f"{base}/{path}"
        data = _json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": header,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                raw = resp.read().decode("utf-8")
                headers = {k.lower(): v for k, v in resp.headers.items()}
                return (_json.loads(raw) if raw.strip() else {}), headers, None
        except Exception as e:  # noqa: BLE001
            status = getattr(e, "code", None)
            try:
                detail = e.read().decode("utf-8")[:300]  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                detail = str(e)
            # HubSpot ECHOES THE TOKEN back in some 403 bodies. Measured 2026-08-21 on
            # /content/api/v2/templates: "This oauth-token (pat-na2-6b0a2) does not have
            # proper permissions!". That string was being returned to the agent and written
            # into logs — a partial credential, which this project's rules forbid logging at
            # all. Redacted before the detail is used for anything.
            import re as _re
            detail = _re.sub(r"pat-[A-Za-z0-9]+-[A-Za-z0-9]+", "pat-[redacted]", detail)
            detail = _re.sub(r"pat-[A-Za-z0-9]{4,}", "pat-[redacted]", detail)
            if status == 401:
                return None, {}, (
                    "HubSpot rejected the stored private app token (401). It may have been "
                    "rotated or deleted in HubSpot."
                )
            if status == 403:
                # The scopes cannot be listed (fact 3), so name the likely cause rather
                # than pretending to know which one is missing.
                return None, {}, (
                    "HubSpot refused this call (403). The private app token is valid but is "
                    "missing a scope for this object type — a private app token's scopes are "
                    "fixed when it is created and cannot be read back through the API, so "
                    f"check the app's scopes in HubSpot. Detail: {detail}"
                )
            if status == 429:
                return None, {}, (
                    "HubSpot rate limit reached (429). Wait and retry; "
                    "hubspot_get_api_usage reports the account's daily limit."
                )
            if status == 404:
                return None, {}, f"HubSpot returned 404 for {url} — no such record or endpoint."
            return None, {}, f"HubSpot request failed ({status}): {detail}"

    def _norm_type(object_type):
        """Accept the singular the model will inevitably use, reject the unknown."""
        t = str(object_type or "").strip().lower()
        aliases = {
            "company": "companies", "companies": "companies",
            "contact": "contacts", "contacts": "contacts",
            "deal": "deals", "deals": "deals",
            "ticket": "tickets", "tickets": "tickets",
        }
        return aliases.get(t)

    def _cap(n, default, hi):
        try:
            return max(1, min(int(n or default), hi))
        except (TypeError, ValueError):
            return default

    def _shape(row, object_type):
        """One CRM record, flattened — properties nested one level down read badly."""
        props = row.get("properties") or {}
        out = {"id": row.get("id")}
        for k, v in props.items():
            if v not in (None, ""):
                out[k] = v
        out["url"] = f"https://app.hubspot.com/contacts/{_portal_id()}/record/{_OBJ_TYPE_ID.get(object_type, '')}/{row.get('id')}"
        return out

    # portalId is needed for record links and is stable for the life of the container,
    # so it is fetched at most once rather than on every row.
    _portal_cache = {}

    def _portal_id():
        if "id" not in _portal_cache:
            data, _h, err = _request("/account-info/v3/details")
            _portal_cache["id"] = "" if err else str((data or {}).get("portalId") or "")
        return _portal_cache["id"]

    # HubSpot's record URLs key on the numeric object type id, not the name.
    _OBJ_TYPE_ID = {"contacts": "0-1", "companies": "0-2", "deals": "0-3", "tickets": "0-5"}

    def _list_objects(object_type, limit, after=None, properties=None):
        props = properties or DEFAULT_PROPERTIES.get(object_type, [])
        path = f"/crm/v3/objects/{object_type}?limit={_cap(limit, 20, 100)}"
        if props:
            path += "&properties=" + ",".join(props)
        if after:
            path += f"&after={after}"
        return _request(path)

    # ---- CompaniesList --------------------------------------------------------------
    def hubspot_list_companies(limit: int = 20, after: str = "") -> dict:
        """List companies in the HubSpot CRM, with their names and domains.

        Args:
            limit: how many to return (default 20, max 100).
            after: paging cursor from a previous call's `nextPage`. Omit for the first page.

        Returns:
            dict with `companies` (id, name, domain, industry, city, country, url),
            `shown`, and `nextPage` when more exist — or `error`.
        """
        data, _h, err = _list_objects("companies", limit, after or None)
        if err:
            return {"error": err}
        rows = [_shape(r, "companies") for r in (data.get("results") or [])]
        out = {"companies": rows, "shown": len(rows)}
        nxt = ((data.get("paging") or {}).get("next") or {}).get("after")
        if nxt:
            out["nextPage"] = nxt
            # HubSpot's list endpoint gives no total at all, so say what is unknown
            # rather than letting `shown` be read as "how many companies there are".
            out["note"] = (
                "This is one page, not the whole CRM. HubSpot does not return a total for a "
                "plain list — use hubspot_search to count matches for a specific query."
            )
        return out

    # ---- the neighbours an agent needs to be useful --------------------------------
    def hubspot_list_contacts(limit: int = 20, after: str = "") -> dict:
        """List contacts (people) in the HubSpot CRM, with their email and name.

        Args:
            limit: how many to return (default 20, max 100).
            after: paging cursor from a previous call's `nextPage`.

        Returns:
            dict with `contacts`, `shown`, and `nextPage` when more exist — or `error`.
        """
        data, _h, err = _list_objects("contacts", limit, after or None)
        if err:
            return {"error": err}
        rows = [_shape(r, "contacts") for r in (data.get("results") or [])]
        out = {"contacts": rows, "shown": len(rows)}
        nxt = ((data.get("paging") or {}).get("next") or {}).get("after")
        if nxt:
            out["nextPage"] = nxt
        return out

    def hubspot_list_deals(limit: int = 20, after: str = "") -> dict:
        """List deals in the HubSpot CRM, with amount and pipeline stage.

        Args:
            limit: how many to return (default 20, max 100).
            after: paging cursor from a previous call's `nextPage`.

        Returns:
            dict with `deals`, `shown`, and `nextPage` when more exist — or `error`.
        """
        data, _h, err = _list_objects("deals", limit, after or None)
        if err:
            return {"error": err}
        rows = [_shape(r, "deals") for r in (data.get("results") or [])]
        out = {"deals": rows, "shown": len(rows)}
        nxt = ((data.get("paging") or {}).get("next") or {}).get("after")
        if nxt:
            out["nextPage"] = nxt
        return out

    def hubspot_get_record(object_type: str, record_id: str) -> dict:
        """Get one HubSpot record by its id.

        Args:
            object_type: one of companies, contacts, deals, tickets.
            record_id: the numeric HubSpot record id.

        Returns:
            dict with the record's properties and `url`, or `error`.
        """
        t = _norm_type(object_type)
        if not t:
            return {"error": f"unknown object type {object_type!r}; use one of {', '.join(OBJECT_TYPES)}"}
        if not str(record_id or "").strip():
            return {"error": "record_id is required"}
        props = DEFAULT_PROPERTIES.get(t, [])
        path = f"/crm/v3/objects/{t}/{str(record_id).strip()}"
        if props:
            path += "?properties=" + ",".join(props)
        data, _h, err = _request(path)
        if err:
            return {"error": err}
        return _shape(data, t)

    def hubspot_search(object_type: str, query: str, limit: int = 20) -> dict:
        """Search HubSpot records by a free-text term, and get the total match count.

        Use this for "how many" questions: unlike the list tools, search returns a real
        `total` for the query.

        Args:
            object_type: one of companies, contacts, deals, tickets.
            query: the text to search for (a company name, an email, a deal name).
            limit: how many matches to return (default 20, max 100).

        Returns:
            dict with `matches`, `shown`, `total` (all matches, not just those shown),
            or `error`.
        """
        t = _norm_type(object_type)
        if not t:
            return {"error": f"unknown object type {object_type!r}; use one of {', '.join(OBJECT_TYPES)}"}
        if not str(query or "").strip():
            return {"error": "query is required — to list everything, use the list tool for this object type instead"}
        body = {
            "query": str(query).strip(),
            "limit": _cap(limit, 20, 100),
            "properties": DEFAULT_PROPERTIES.get(t, []),
        }
        data, _h, err = _request(f"/crm/v3/objects/{t}/search", method="POST", body=body)
        if err:
            return {"error": err}
        rows = [_shape(r, t) for r in (data.get("results") or [])]
        return {"matches": rows, "shown": len(rows), "total": data.get("total")}

    # ---- ListAssociations -----------------------------------------------------------
    def hubspot_list_associations(from_object_type: str, record_id: str,
                                  to_object_type: str, limit: int = 25) -> dict:
        """Find the records linked to a HubSpot record — e.g. which contacts belong to a
        company, or which deals a contact is on.

        Args:
            from_object_type: the type of the record you have (companies, contacts,
                deals, tickets).
            record_id: that record's numeric HubSpot id.
            to_object_type: the type of record you want linked ones for.
            limit: how many links to return (default 25, max 100).

        Returns:
            dict with `associations` — each with `id`, a human `name`, `url`, and the
            association `labels` — plus `shown`, or `error`.
        """
        src = _norm_type(from_object_type)
        dst = _norm_type(to_object_type)
        if not src or not dst:
            return {"error": f"object types must be among {', '.join(OBJECT_TYPES)}"}
        if not str(record_id or "").strip():
            return {"error": "record_id is required"}
        data, _h, err = _request(
            f"/crm/v4/objects/{src}/{str(record_id).strip()}/associations/{dst}"
            f"?limit={_cap(limit, 25, 100)}"
        )
        if err:
            return {"error": err}
        results = data.get("results") or []
        if not results:
            return {
                "associations": [], "shown": 0,
                "note": f"No {dst} are linked to that {SINGULAR.get(src, src)} in HubSpot.",
            }

        # HYDRATE. The v4 association endpoint returns toObjectId and nothing else, so an
        # un-hydrated answer is a list of 18-digit numbers. One batch read turns them into
        # names, which is the entire difference between answering the question and not.
        ids = [str(r.get("toObjectId")) for r in results if r.get("toObjectId") is not None]
        name_prop = NAME_PROPERTY.get(dst, "name")
        names = {}
        if ids:
            batch, _h2, berr = _request(
                f"/crm/v3/objects/{dst}/batch/read",
                method="POST",
                body={"properties": DEFAULT_PROPERTIES.get(dst, [name_prop]),
                      "inputs": [{"id": i} for i in ids]},
            )
            if not berr:
                for row in (batch.get("results") or []):
                    names[str(row.get("id"))] = row.get("properties") or {}

        assocs = []
        for r in results:
            rid = str(r.get("toObjectId"))
            props = names.get(rid, {})
            label = props.get(name_prop) or ""
            if dst == "contacts" and not label:
                # A contact with no email still has a name worth showing.
                label = " ".join(x for x in [props.get("firstname"), props.get("lastname")] if x)
            assocs.append({
                "id": rid,
                "name": label or f"(unnamed {SINGULAR.get(dst, dst)} {rid})",
                "url": f"https://app.hubspot.com/contacts/{_portal_id()}/record/{_OBJ_TYPE_ID.get(dst, '')}/{rid}",
                # The association LABEL is the relationship's meaning ("Billing Contact"),
                # which is often the actual answer to the user's question.
                "labels": [t.get("label") for t in (r.get("associationTypes") or []) if t.get("label")],
            })
        out = {"associations": assocs, "shown": len(assocs)}
        if not names:
            out["note"] = (
                "Names could not be read for these records — only their ids are shown. This "
                "usually means the private app token lacks read scope on " + dst + "."
            )
        return out

    # ---- GetTheDailyApiUsageAndLimitsForAHubspotAccount ------------------------------
    def hubspot_get_api_usage() -> dict:
        """How much of the HubSpot daily API limit this account has used.

        Returns:
            dict with `dailyLimit`, `remainingNow`, `usedNow`, and HubSpot's own
            `snapshot` (its periodically-collected figure and when it was collected),
            or `error`.
        """
        data, headers, err = _request("/account-info/v3/api-usage/daily/private-apps")
        if err:
            return {"error": err}

        # TWO SOURCES, AND THEY DISAGREE — deliberately both reported.
        #
        # The endpoint's `currentUsage` is a periodically-collected snapshot carrying its
        # own `collectedAt`; measured 2026-08-20 it read 0 while the response header for
        # the very same request said 12 calls had been used today. The header is current.
        # Quoting the snapshot as "calls used today" is wrong in the way nobody checks,
        # so the live figure leads and the snapshot is labelled as a snapshot.
        rows = data.get("results") or []
        first = rows[0] if rows else {}
        limit_hdr = headers.get("x-hubspot-ratelimit-daily")
        remaining_hdr = headers.get("x-hubspot-ratelimit-daily-remaining")
        out = {}
        try:
            if limit_hdr is not None:
                out["dailyLimit"] = int(limit_hdr)
            if remaining_hdr is not None:
                out["remainingNow"] = int(remaining_hdr)
            if "dailyLimit" in out and "remainingNow" in out:
                out["usedNow"] = out["dailyLimit"] - out["remainingNow"]
        except (TypeError, ValueError):
            pass
        if "dailyLimit" not in out and first.get("usageLimit") is not None:
            out["dailyLimit"] = first.get("usageLimit")
        out["snapshot"] = {
            "currentUsage": first.get("currentUsage"),
            "collectedAt": first.get("collectedAt"),
            "resetsAt": first.get("resetsAt"),
            "name": first.get("name"),
        }
        out["note"] = (
            "`usedNow`/`remainingNow` are live, read from this request's own rate-limit "
            "headers. `snapshot.currentUsage` is HubSpot's periodically-collected figure "
            "and lags — it can read 0 on an account that has served calls this minute. "
            "Quote the live numbers, and only cite the snapshot with its collectedAt time. "
            "This limit covers ALL private apps on the account, not this agent alone."
        )
        return out

    def hubspot_list_templates(limit: int = 20) -> dict:
        """List the CMS templates (page/email designs) in this HubSpot account.

        Args:
            limit: how many to return (default 20, max 100).

        Returns:
            dict with `templates` (id, path, label, categoryId) and `shown` — or `error`.
        """
        # LEGACY ENDPOINT ON PURPOSE. Measured 2026-08-21 against portal 246967746:
        #   /cms/v3/design-manager/templates -> 404 (no such v3 endpoint on this portal)
        #   /content/api/v2/templates        -> 403, and its body NAMES the scopes it wants
        # So the v2 path is the only one that exists for templates, and its 403 is a scope
        # problem rather than a wrong URL. Reported as such, with the scope names, because
        # "403" alone sends the reader looking for a bug in this code.
        data, _h, err = _request(f"/content/api/v2/templates?limit={_cap(limit, 20, 100)}")
        if err:
            if "403" in str(err) or "permissions" in str(err).lower():
                return {"error": (
                    "HubSpot refused the CMS templates call. The private app token is valid "
                    "but has no CMS access: this endpoint requires one of "
                    "design-manager-access, content-editor-access or landingpages-read "
                    "(HubSpot also gates the newer CMS APIs behind the `content` scope). A "
                    "private app's scopes are fixed when it is created and cannot be read "
                    "back through the API, so add the scope in HubSpot and issue a new token."
                )}
            return {"error": err}
        rows = data.get("objects") or data.get("results") or []
        templates = [{
            "id": t.get("id"),
            "path": t.get("path"),
            "label": t.get("label") or t.get("filename"),
            "categoryId": t.get("category_id") or t.get("categoryId"),
        } for t in rows]
        return {"templates": templates, "shown": len(templates)}

    def hubspot_get_account_info() -> dict:
        """Basic facts about the connected HubSpot account — portal id, account type,
        currency and time zone. Useful to confirm WHICH HubSpot account this agent reads.

        Returns:
            dict with portalId, accountType, timeZone, companyCurrency, or `error`.
        """
        data, _h, err = _request("/account-info/v3/details")
        if err:
            return {"error": err}
        return {
            "portalId": data.get("portalId"),
            "accountType": data.get("accountType"),
            "timeZone": data.get("timeZone"),
            "companyCurrency": data.get("companyCurrency"),
            "uiDomain": data.get("uiDomain"),
        }

    return [
        hubspot_list_companies,
        hubspot_list_contacts,
        hubspot_list_deals,
        hubspot_get_record,
        hubspot_search,
        hubspot_list_associations,
        hubspot_get_api_usage,
        hubspot_get_account_info,
        hubspot_list_templates,
    ]
