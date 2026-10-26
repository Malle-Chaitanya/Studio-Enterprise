"""Google Contacts (People API) live tools — the Google-side equivalent of Copilot's
Office 365 Outlook Contacts operations (Create contact (V2), Get contact (V2), Get
contact folders (V2), Get contacts (V2), Update contact (V2)).

Confirmed against Google's own official People API reference (2026-09-01):
`people.connections.list`, `people.get`, `people.createContact`,
`people.updateContact` and `contactGroups.list` all exist, are documented, and need
nothing beyond the `contacts` OAuth scope via DWD — same shape as gmail.py and
calendar.py before it. There was previously NO contacts tool in this codebase at all
(connectors/equivalence.ts's MCP_SERVERS row for `mcp_ContactsManagement` said so
explicitly: "No Google Contacts tools exist in this product yet"); this module is
what closes that gap.

Like gmail.py and calendar.py, this is CROSS-VENDOR: a Copilot agent that read/wrote
Outlook contacts migrates to one that reads/writes the impersonated account's Google
Contacts. The intent survives; the shapes differ in a few places, documented per tool
below:

  * Outlook contacts live in FOLDERS (a contact is in exactly one). Google groups
    (`contactGroups.list`) are more like labels — a contact can belong to several, or
    none. "Get contact folders" therefore narrows to "list groups", same category of
    gap MoveV2/GetMailboxFolders already documents for mail.
  * People API updates require an `etag` — a concurrency-control field Outlook's
    contact update does not have. This module fetches the current contact first to
    get it, so the caller never has to know the mechanism exists.
  * `resourceName` (e.g. "people/c1234567890"), not a plain numeric id, is what
    identifies a Google contact. A source id from Outlook (a GUID) has no meaning
    here; contact ids are NOT portable across vendors, so `contacts_list_contacts`
    is how a migrated agent has to look a person up first.

IDENTITY: same pattern as gmail.py/calendar.py — Domain-Wide Delegation with a single
impersonated subject. Every response carries `mailbox` (whose contacts these are), so
an answer can never silently look like it is about someone else's address book.

AUTH: requires the `https://www.googleapis.com/auth/contacts` scope via DWD, granted
SEPARATELY from Gmail/Calendar scopes — same relationship those two have to each
other (see connector_tools/calendar.py's own AUTH note).

UNVERIFIED: written against the documented API shape but not yet exercised against a
live tenant — see the honesty-gate rule on connectors/equivalence.ts's `verified`
field. The contacts scope has not been authorised in DWD for any customer yet, so
there has been nothing to call.

See connector_tools/gmail.py for the shared build_tools contract and the reasoning
behind nesting every helper inside build_tools (cloudpickle needs them pickled BY
VALUE, not by module-level reference).
"""

API = "https://people.googleapis.com/v1"

# Same reasoning as gmail.py's MAX_RESULTS: a wall of contacts buries the answer and
# burns the context window for no benefit to the model or the user.
MAX_RESULTS = 25
DEFAULT_RESULTS = 10

# The People API returns almost nothing unless the caller asks for it by name. Fixed
# to the fields these tools actually surface, so every response shape stays predictable
# regardless of what else is populated on a given contact.
PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations"


def build_tools(conn, secret, mint_token, auth_header, fill):
    def _mailbox() -> str:
        """Whose contacts these tools read/write. Reported on every response."""
        try:
            return secret("impersonate_email") or "(unknown)"
        except Exception:  # noqa: BLE001 — identity is informational, never fatal
            return "(unknown)"

    def _get(path: str, params: dict, token: str) -> dict:
        import json as _json
        import urllib.parse
        import urllib.request

        url = f"{API}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=25) as resp:
            return _json.loads(resp.read().decode("utf-8"))

    def _write(path: str, body: dict, token: str, method: str = "POST") -> dict:
        import json as _json
        import urllib.request

        req = urllib.request.Request(
            f"{API}{path}",
            data=_json.dumps(body).encode("utf-8"),
            method=method,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8")
            return _json.loads(raw) if raw else {}

    def _err(e, what: str) -> dict:
        """Google, like Graph, puts the real reason in the response BODY, not the status
        line — see connector_tools/outlook.py's `_err` for the same pattern."""
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:400]
        except Exception:  # noqa: BLE001
            detail = str(e)
        return {"error": f"{what}: {detail}"}

    def _flatten(person: dict) -> dict:
        names = person.get("names", []) or []
        emails = person.get("emailAddresses", []) or []
        phones = person.get("phoneNumbers", []) or []
        orgs = person.get("organizations", []) or []
        return {
            "resourceName": person.get("resourceName"),
            "displayName": (names[0].get("displayName") if names else None) or "(no name)",
            "emails": [e.get("value") for e in emails if e.get("value")],
            "phones": [p.get("value") for p in phones if p.get("value")],
            "organization": orgs[0].get("name") if orgs else None,
        }

    def contacts_list_contacts(max_results: int = DEFAULT_RESULTS) -> dict:
        """List contacts in the account's address book — the equivalent of Outlook's "Get
        contacts". Use this to find a resourceName before calling contacts_get_contact or
        contacts_update_contact; contact ids are NOT shared across Outlook and Google.

        Args:
            max_results: how many contacts to return, 1-25. Defaults to 10.

        Returns:
            dict with `mailbox`, `contacts` (resourceName, displayName, emails, phones,
            organization), `count`, `truncated`, or `error`.
        """
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            want = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
        except (TypeError, ValueError):
            want = DEFAULT_RESULTS
        params = {"personFields": PERSON_FIELDS, "pageSize": str(want)}
        try:
            data = _get("/people/me/connections", params, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Contacts list failed: {e}"}
        contacts = [_flatten(p) for p in data.get("connections", []) or []]
        return {
            "mailbox": _mailbox(),
            "contacts": contacts,
            "count": len(contacts),
            "truncated": bool(data.get("nextPageToken")),
        }

    def contacts_get_contact(resource_name: str) -> dict:
        """Get one contact's full details by resourceName — the equivalent of Outlook's
        "Get contact". Get a resourceName from contacts_list_contacts first.

        Args:
            resource_name: e.g. "people/c1234567890", from contacts_list_contacts.

        Returns:
            dict with `mailbox`, `resourceName`, `displayName`, `emails`, `phones`,
            `organization`, or `error`.
        """
        if not resource_name:
            return {"error": "resource_name is required. Call contacts_list_contacts first."}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            person = _get(f"/{resource_name}", {"personFields": PERSON_FIELDS}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Contact lookup failed: {e}"}
        return {"mailbox": _mailbox(), **_flatten(person)}

    def contacts_list_contact_groups() -> dict:
        """List the account's contact groups — the closest Google equivalent of Outlook's
        "Get contact folders". NOT the same shape: an Outlook contact lives in exactly one
        folder, a Google contact can belong to several groups, or none.

        Returns:
            dict with `mailbox`, `groups` (resourceName, name, memberCount), `count`, or
            `error`.
        """
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            data = _get("/contactGroups", {}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Contact groups list failed: {e}"}
        groups = [
            {
                "resourceName": g.get("resourceName"),
                "name": g.get("formattedName") or g.get("name"),
                "memberCount": g.get("memberCount", 0),
            }
            for g in data.get("contactGroups", []) or []
        ]
        return {"mailbox": _mailbox(), "groups": groups, "count": len(groups)}

    def contacts_create_contact(
        display_name: str,
        email: str = "",
        phone: str = "",
        organization: str = "",
    ) -> dict:
        """Create a new contact — the equivalent of Outlook's "Create contact". Always
        confirm the name and at least one contact method with the user before calling
        this; it is a real write to their address book.

        Args:
            display_name: the contact's full name.
            email: optional email address.
            phone: optional phone number.
            organization: optional company/organization name.

        Returns:
            dict with `created` true, `resourceName`, `displayName`, or `error`.
        """
        if not display_name:
            return {"error": "display_name is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        body: dict = {"names": [{"unstructuredName": display_name}]}
        if email:
            body["emailAddresses"] = [{"value": email}]
        if phone:
            body["phoneNumbers"] = [{"value": phone}]
        if organization:
            body["organizations"] = [{"name": organization}]
        try:
            created = _write(
                f"/people:createContact?personFields={PERSON_FIELDS}", body, token,
            )
        except Exception as e:  # noqa: BLE001
            return {"error": f"Contact creation failed: {e}"}
        return {"created": True, "mailbox": _mailbox(), **_flatten(created)}

    def contacts_update_contact(
        resource_name: str,
        display_name: str = "",
        email: str = "",
        phone: str = "",
    ) -> dict:
        """Update an existing contact — the equivalent of Outlook's "Update contact". Only
        the fields you pass are changed; leave the rest blank to keep them as-is.

        Args:
            resource_name: e.g. "people/c1234567890", from contacts_list_contacts.
            display_name: new full name, or blank to leave unchanged.
            email: new email address, or blank to leave unchanged. Replaces the existing
                email list rather than appending — the People API has no "add one more"
                operation for a single field.
            phone: new phone number, or blank to leave unchanged. Same replace behaviour.

        Returns:
            dict with `updated` true, `resourceName`, `displayName`, or `error`.
        """
        if not resource_name:
            return {"error": "resource_name is required. Call contacts_list_contacts first."}
        if not display_name and not email and not phone:
            return {"error": "nothing to update — pass at least one field"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        # The People API requires the current `etag` on every update, to detect a
        # concurrent edit Outlook's contact update has no equivalent concept of — fetched
        # here so the caller never has to know the mechanism exists.
        try:
            current = _get(f"/{resource_name}", {"personFields": PERSON_FIELDS}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Contact lookup before update failed: {e}"}
        etag = current.get("etag")
        if not etag:
            return {"error": "could not read the contact's etag — update requires it"}
        body: dict = {"etag": etag}
        fields = []
        if display_name:
            body["names"] = [{"unstructuredName": display_name}]
            fields.append("names")
        if email:
            body["emailAddresses"] = [{"value": email}]
            fields.append("emailAddresses")
        if phone:
            body["phoneNumbers"] = [{"value": phone}]
            fields.append("phoneNumbers")
        try:
            updated = _write(
                f"/{resource_name}:updateContact?updatePersonFields={','.join(fields)}",
                body,
                token,
                method="PATCH",
            )
        except Exception as e:  # noqa: BLE001
            return {"error": f"Contact update failed: {e}"}
        return {"updated": True, "mailbox": _mailbox(), **_flatten(updated)}

    # READ tools first, same convention as gmail.py/calendar.py — the model reaches for
    # what it sees earliest, and looking a contact up before writing is the safer default.
    return [
        contacts_list_contacts,
        contacts_get_contact,
        contacts_list_contact_groups,
        contacts_create_contact,
        contacts_update_contact,
    ]
