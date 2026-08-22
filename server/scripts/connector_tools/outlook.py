"""Outlook live tools — Microsoft Graph, for an agent that moves to Gemini while its MAIL
STAYS in Microsoft 365.

This is the option a phased migration needs. Copilot Studio's Office 365 Outlook connector
cannot be re-bound directly (its swagger describes a Power Platform dataset abstraction, not
Graph paths — see connectors/operationBinding.ts `proxyReason`), so the operations are
rebuilt here against Graph itself.

WHY THIS EXISTS ALONGSIDE gmail.py: a customer moving agents to Gemini has not necessarily
decided to move their mail. Offering only Gmail forced a mail migration as a side effect of
an agent migration, which is not a trade anyone asked to make. Choosing this keeps mail
behaviour IDENTICAL — folders stay folders, flags stay flags with their due dates, categories
keep their colours. Nothing in the equivalence table applies, because nothing is being
translated.

AUTH: app-only (`client_credentials`) against the customer's OWN Entra app registration —
the same `ms_graph` credential SharePoint and OneDrive already use. It needs the APPLICATION
permissions `Mail.ReadWrite` and `Mail.Send` with admin consent — plus
`Calendars.Read` for outlook_list_calendar_events, which is a SEPARATE grant and is
not implied by the mail ones. Without them Graph answers
403 on every call and the agent looks broken rather than unconfigured, so each tool reports
the Graph error verbatim instead of flattening it.

IDENTITY: app-only means tenant-wide reach, so the mailbox is named explicitly per agent
(`impersonate_email`) rather than inferred from the caller. Copilot's Invoker mode read the
CALLER's mail as the caller; a deployed agent holds one identity. Every response therefore
carries `mailbox`, so an answer can never silently appear to be about the reader's own mail.

READ + WRITE, mirroring gmail.py. Deletion moves to Deleted Items, never a permanent purge.

See connector_tools/google_drive.py for the shared build_tools contract.
"""

GRAPH = "https://graph.microsoft.com/v1.0"

# Caps exist for the MODEL's benefit as much as the API's: a 200-message dump buries the
# answer and burns the context window.
MAX_RESULTS = 25
DEFAULT_RESULTS = 10
MAX_BODY_CHARS = 20000


def build_tools(conn, secret, mint_token, auth_header, fill):
    # Helpers are nested, NOT module level. cloudpickle serialises these closures by value
    # into the Reasoning Engine pickle; a module-level helper is pickled by REFERENCE as
    # `connector_tools.outlook._x`, which the container cannot resolve at unpickle time and
    # the whole engine fails to start with `ModuleNotFoundError: No module named
    # 'connector_tools'`. Confirmed live 2026-08-19 on the Gmail module, which was written
    # the wrong way round first. Module-level CONSTANTS are fine.

    def _mailbox() -> str:
        """Whose mailbox these tools read. Reported on every response."""
        try:
            return secret("impersonate_email") or "(unknown)"
        except Exception:  # noqa: BLE001 — identity is informational, never fatal
            return "(unknown)"

    def _user_path() -> str:
        return f"/users/{_mailbox()}"

    def _strip_html(html: str) -> str:
        """Crude tag strip for messages Graph returns as HTML. Not a parser: the goal is that
        the model sees the words rather than the markup."""
        import re
        import html as _html

        text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
        text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", text)
        text = re.sub(r"(?s)<[^>]+>", " ", text)
        text = _html.unescape(text)
        text = re.sub(r"[ \t\r\f\v]+", " ", text)
        return re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()

    def _addr(recipients) -> str:
        """Flatten Graph's [{emailAddress:{address,name}}] into a readable string."""
        out = []
        for r in recipients or []:
            ea = (r or {}).get("emailAddress", {}) or {}
            out.append(ea.get("address") or ea.get("name") or "")
        return ", ".join(x for x in out if x)

    def _to_recipients(csv: str):
        return [{"emailAddress": {"address": a.strip()}} for a in (csv or "").split(",") if a.strip()]

    def _graph(path: str, token: str, params: dict = None, *, method: str = "GET", body: dict = None):
        import json as _json
        import urllib.parse
        import urllib.request

        url = f"{GRAPH}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        data = _json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": f"Bearer {token}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8")
            return _json.loads(raw) if raw else {}

    def _err(e, what: str) -> dict:
        """Graph puts the real reason in the response BODY, not the status line. A bare
        'HTTP Error 403' tells the customer nothing; 'Access is denied. Check credentials'
        tells them to grant the application permission."""
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:400]
        except Exception:  # noqa: BLE001
            detail = str(e)
        return {"error": f"{what}: {detail}"}

    def outlook_search_messages(query: str = "", max_results: int = DEFAULT_RESULTS) -> dict:
        """Search the mailbox and return matching emails with sender, subject and date.

        Use this to answer questions about someone's mail, for example "did the invoice from
        Acme arrive", "what did Priya send last week", or "any unread mail about the audit".

        Args:
            query: free text to search for across the message. Leave empty for the most
                recent messages. Examples: "invoice", "from Priya", "audit".
            max_results: how many to return, 1-25. Defaults to 10.

        Returns:
            dict with `mailbox`, `messages` (id, from, to, subject, date, preview, unread,
            hasAttachments, folder), `count`, or `error`.
        """
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            want = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
        except (TypeError, ValueError):
            want = DEFAULT_RESULTS

        params = {
            "$top": str(want),
            "$select": "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,parentFolderId",
        }
        if query:
            # $search and $orderby are mutually exclusive in Graph — asking for both returns
            # a 400, so ordering is only applied on the unfiltered listing.
            params["$search"] = f'"{query}"'
        else:
            params["$orderby"] = "receivedDateTime desc"

        try:
            data = _graph(f"{_user_path()}/messages", token, params)
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook search failed")

        messages = [{
            "id": m.get("id"),
            "from": _addr([m.get("from")]) if m.get("from") else "",
            "to": _addr(m.get("toRecipients")),
            "subject": m.get("subject") or "(no subject)",
            "date": m.get("receivedDateTime", ""),
            "preview": (m.get("bodyPreview") or "")[:300],
            "unread": not m.get("isRead", True),
            "hasAttachments": bool(m.get("hasAttachments")),
        } for m in data.get("value", [])]

        return {"mailbox": _mailbox(), "query": query, "messages": messages,
                "count": len(messages), "truncated": bool(data.get("@odata.nextLink"))}

    def outlook_read_message(message_id: str) -> dict:
        """Read the full text of one email, so you can answer questions about what it says.

        Get a message_id from outlook_search_messages first.

        Returns:
            dict with `mailbox`, `from`, `to`, `cc`, `subject`, `date`, `body`, `categories`,
            `flag`, `attachments` (names only), or `error`.
        """
        if not message_id:
            return {"error": "message_id is required. Call outlook_search_messages first."}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            m = _graph(f"{_user_path()}/messages/{message_id}", token, {
                "$select": "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,"
                           "categories,flag,hasAttachments,isRead",
            })
        except Exception as e:  # noqa: BLE001
            return _err(e, f"Outlook read failed for {message_id}")

        body = (m.get("body") or {})
        text = body.get("content") or ""
        if (body.get("contentType") or "").lower() == "html":
            text = _strip_html(text)

        attachments = []
        if m.get("hasAttachments"):
            try:
                att = _graph(f"{_user_path()}/messages/{message_id}/attachments", token,
                             {"$select": "name,contentType,size"})
                attachments = [a.get("name") for a in att.get("value", []) if a.get("name")]
            except Exception:  # noqa: BLE001 — the message is still worth returning
                attachments = ["(attachment list unavailable)"]

        return {
            "mailbox": _mailbox(), "id": m.get("id"),
            "from": _addr([m.get("from")]) if m.get("from") else "",
            "to": _addr(m.get("toRecipients")), "cc": _addr(m.get("ccRecipients")),
            "subject": m.get("subject") or "(no subject)",
            "date": m.get("receivedDateTime", ""),
            "categories": m.get("categories", []),
            # Outlook flags carry a STATE and a due date — unlike a Gmail star. Reported in
            # full precisely because this path exists to preserve that.
            "flag": (m.get("flag") or {}).get("flagStatus"),
            "attachments": attachments,
            "body": text[:MAX_BODY_CHARS], "truncated": len(text) > MAX_BODY_CHARS,
        }

    def outlook_list_folders() -> dict:
        """List the mail folders in the mailbox.

        Unlike Gmail labels, an Outlook message lives in exactly ONE folder, so a folder name
        identifies where a message is without ambiguity.

        Returns:
            dict with `folders` (id, name, unreadCount, totalCount), `count`, or `error`.
        """
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            data = _graph(f"{_user_path()}/mailFolders", token, {"$top": "50"})
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook folder list failed")
        folders = [{"id": f.get("id"), "name": f.get("displayName"),
                    "unreadCount": f.get("unreadItemCount"), "totalCount": f.get("totalItemCount")}
                   for f in data.get("value", [])]
        return {"mailbox": _mailbox(), "folders": folders, "count": len(folders)}

    def outlook_send_message(to: str, subject: str, body: str, cc: str = "") -> dict:
        """Send a NEW email. This is irreversible — the message cannot be recalled.

        ALWAYS show the user the recipient, subject and body and get their explicit agreement
        before calling this. Never send on a guess about what they meant.

        Returns:
            dict with `sent` true, `to`, `subject`, or `error`.
        """
        if not to:
            return {"error": "a recipient (to) is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        payload = {"message": {
            "subject": subject or "",
            "body": {"contentType": "Text", "content": body or ""},
            "toRecipients": _to_recipients(to),
            "ccRecipients": _to_recipients(cc),
        }, "saveToSentItems": True}
        try:
            _graph(f"{_user_path()}/sendMail", token, method="POST", body=payload)
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook send failed")
        return {"sent": True, "mailbox": _mailbox(), "to": to, "subject": subject}

    def outlook_reply_to_message(message_id: str, body: str, reply_all: bool = False) -> dict:
        """Reply to an email, keeping it in the same conversation. Irreversible.

        ALWAYS show the user what you intend to say and get their agreement first.

        Args:
            message_id: the message to reply to.
            body: your plain-text reply.
            reply_all: include everyone on the original, not just the sender.

        Returns:
            dict with `sent` true, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        # Graph threads the reply itself — no header assembly, unlike Gmail.
        action = "replyAll" if reply_all else "reply"
        try:
            _graph(f"{_user_path()}/messages/{message_id}/{action}", token,
                   method="POST", body={"comment": body or ""})
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook reply failed")
        return {"sent": True, "mailbox": _mailbox(), "repliedTo": message_id, "replyAll": bool(reply_all)}

    def outlook_forward_message(message_id: str, to: str, comment: str = "") -> dict:
        """Forward an email to someone else. Irreversible.

        ALWAYS confirm the recipient with the user first — forwarding sends the ORIGINAL
        content to a new person, which can disclose information they should not see.

        Unlike the Gmail equivalent, attachments ARE carried over: Graph has a real forward
        operation rather than requiring the message to be recomposed.

        Returns:
            dict with `sent` true, or `error`.
        """
        if not message_id or not to:
            return {"error": "message_id and to are both required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            _graph(f"{_user_path()}/messages/{message_id}/forward", token, method="POST",
                   body={"comment": comment or "", "toRecipients": _to_recipients(to)})
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook forward failed")
        return {"sent": True, "mailbox": _mailbox(), "to": to,
                "note": "Attachments were forwarded with the message."}

    def outlook_create_draft(to: str, subject: str, body: str, cc: str = "") -> dict:
        """Write an email and SAVE IT AS A DRAFT without sending it.

        Prefer this over outlook_send_message when the user has not clearly asked for the
        mail to go out — a draft is reversible, a sent message is not.

        Returns:
            dict with `draftId`, or `error`.
        """
        if not to:
            return {"error": "a recipient (to) is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            d = _graph(f"{_user_path()}/messages", token, method="POST", body={
                "subject": subject or "",
                "body": {"contentType": "Text", "content": body or ""},
                "toRecipients": _to_recipients(to),
                "ccRecipients": _to_recipients(cc),
            })
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook draft creation failed")
        return {"created": True, "mailbox": _mailbox(), "draftId": d.get("id"),
                "to": to, "subject": subject}

    def outlook_send_draft(draft_id: str) -> dict:
        """Send a draft that already exists. Irreversible.

        ALWAYS read the draft back to the user and get their agreement before sending.

        Returns:
            dict with `sent` true, or `error`.
        """
        if not draft_id:
            return {"error": "draft_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            _graph(f"{_user_path()}/messages/{draft_id}/send", token, method="POST", body={})
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook draft send failed")
        return {"sent": True, "mailbox": _mailbox(), "id": draft_id}

    def outlook_move_message(message_id: str, folder_id: str) -> dict:
        """Move an email to a different folder.

        Unlike the Gmail equivalent this is a true move: the message leaves its old folder.
        Get a folder_id from outlook_list_folders, or use a well-known name such as
        "inbox", "archive", "deleteditems" or "junkemail".

        Returns:
            dict with `moved` true and the new `folderId`, or `error`.
        """
        if not message_id or not folder_id:
            return {"error": "message_id and folder_id are both required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            m = _graph(f"{_user_path()}/messages/{message_id}/move", token,
                       method="POST", body={"destinationId": folder_id})
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook move failed")
        return {"moved": True, "mailbox": _mailbox(), "id": m.get("id"),
                "folderId": m.get("parentFolderId")}

    def outlook_delete_message(message_id: str) -> dict:
        """Move an email to Deleted Items. Recoverable.

        Deliberately a move to Deleted Items, not a permanent purge — an agent destroying
        mail irreversibly is a worse outcome than the small fidelity difference. There is no
        permanent-delete tool here.

        Returns:
            dict with `deleted` true, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            _graph(f"{_user_path()}/messages/{message_id}/move", token,
                   method="POST", body={"destinationId": "deleteditems"})
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook delete failed")
        return {"deleted": True, "mailbox": _mailbox(), "id": message_id,
                "note": "Moved to Deleted Items, recoverable. Not permanently erased."}

    def outlook_flag_message(message_id: str, flagged: bool = True) -> dict:
        """Flag or unflag an email for follow-up.

        An Outlook flag carries a STATE, unlike a boolean star. This is one of the things
        keeping mail in Microsoft preserves.

        Returns:
            dict with `flagged` and `id`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        status = "flagged" if flagged else "notFlagged"
        try:
            m = _graph(f"{_user_path()}/messages/{message_id}", token,
                       method="PATCH", body={"flag": {"flagStatus": status}})
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook flag change failed")
        return {"flagged": bool(flagged), "mailbox": _mailbox(), "id": m.get("id"),
                "flagStatus": (m.get("flag") or {}).get("flagStatus")}

    def outlook_mark_read(message_id: str, read: bool = True) -> dict:
        """Mark an email as read or unread.

        Returns:
            dict with `read` and `id`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            m = _graph(f"{_user_path()}/messages/{message_id}", token,
                       method="PATCH", body={"isRead": bool(read)})
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook read-state change failed")
        return {"read": bool(m.get("isRead")), "mailbox": _mailbox(), "id": m.get("id")}

    def outlook_set_categories(message_id: str, categories: str = "") -> dict:
        """Set the Outlook categories on an email.

        Categories keep their names AND their colours here, which is one of the things a move
        to Gmail cannot preserve.

        Args:
            message_id: the message to change.
            categories: category names, comma separated. Empty clears them.

        Returns:
            dict with `categories` and `id`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        cats = [c.strip() for c in (categories or "").split(",") if c.strip()]
        try:
            m = _graph(f"{_user_path()}/messages/{message_id}", token,
                       method="PATCH", body={"categories": cats})
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook category change failed")
        return {"mailbox": _mailbox(), "id": m.get("id"), "categories": m.get("categories", [])}

    def outlook_get_attachment(message_id: str, filename: str = "") -> dict:
        """Read the TEXT content of an attachment on an email.

        Only plain-text formats are readable (txt, csv, json, xml). Binary formats such as
        PDF, Word and Excel are reported with their size but NOT decoded — say so rather than
        guessing at their contents.

        Args:
            message_id: the message holding the attachment.
            filename: which attachment. Leave empty to list what is available.

        Returns:
            dict with `attachments` (when listing), or `filename`/`content`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            data = _graph(f"{_user_path()}/messages/{message_id}/attachments", token)
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook attachment list failed")

        found = [{"filename": a.get("name"), "mimeType": a.get("contentType", ""),
                  "size": a.get("size", 0), "contentBytes": a.get("contentBytes")}
                 for a in data.get("value", [])]
        if not found:
            return {"mailbox": _mailbox(), "attachments": [], "count": 0,
                    "note": "This message has no attachments."}
        if not filename:
            return {"mailbox": _mailbox(),
                    "attachments": [{k: v for k, v in a.items() if k != "contentBytes"} for a in found],
                    "count": len(found),
                    "note": "Call again with a filename to read one of these."}

        match = next((a for a in found if (a["filename"] or "").lower() == filename.lower()), None)
        if not match:
            return {"error": f"no attachment named {filename!r}. Available: "
                             f"{', '.join(str(a['filename']) for a in found)}"}
        readable = ("text/", "application/json", "application/xml")
        if not any((match["mimeType"] or "").startswith(t) for t in readable):
            return {"mailbox": _mailbox(), "filename": match["filename"],
                    "mimeType": match["mimeType"], "size": match["size"], "content": None,
                    "note": "This is a binary format and its contents were NOT read. "
                            "Do not describe what it contains."}
        import base64
        try:
            text = base64.b64decode(match["contentBytes"] or "").decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            text = ""
        return {"mailbox": _mailbox(), "filename": match["filename"],
                "mimeType": match["mimeType"], "size": match["size"],
                "content": text[:MAX_BODY_CHARS], "truncated": len(text) > MAX_BODY_CHARS}

    # Read tools first — the model reaches for what it sees earliest, and reading before
    # writing is the safer default when a request is ambiguous.
    def outlook_list_calendar_events(start: str = "", end: str = "",
                                     max_results: int = DEFAULT_RESULTS) -> dict:
        """List calendar events in a date range — what is on the calendar, and when.

        This is a CALENDAR VIEW, which is the only correct way to ask the question: it
        expands recurring series into their individual occurrences. Listing /events instead
        returns the recurrence MASTER once, so a weekly stand-up shows up as a single event
        rather than as the meetings that actually happen in the range asked about.

        Args:
            start: ISO date or datetime for the start of the range (e.g. "2026-08-21" or
                "2026-08-21T09:00:00Z"). Defaults to today.
            end: ISO date or datetime for the end of the range. Defaults to 7 days after
                start.
            max_results: how many events to return (max 50).

        Returns:
            dict with `events` (subject, start, end, isAllDay, organizer, attendees,
            location, isOnlineMeeting, joinUrl), `count`, `range`, and `mailbox` — or
            `error`.
        """
        import datetime as _dt

        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}

        # A missing range must not become an unbounded query. Graph REQUIRES both bounds on
        # calendarView and 400s without them, so a default window is supplied and reported
        # back, rather than letting the model guess a format and see a cryptic error.
        def _iso(v, fallback):
            v = (v or "").strip()
            if not v:
                return fallback
            # A bare date is accepted and widened to the whole day — "what is on my calendar
            # on the 21st" is the common question and "2026-08-21" is how it arrives.
            return f"{v}T00:00:00Z" if len(v) == 10 else v

        today = _dt.datetime.now(_dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        start_iso = _iso(start, today.strftime("%Y-%m-%dT%H:%M:%SZ"))
        end_iso = _iso(end, (today + _dt.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ"))

        try:
            n = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
        except (TypeError, ValueError):
            n = DEFAULT_RESULTS

        try:
            data = _graph(
                f"{_user_path()}/calendarView",
                token,
                {
                    "startDateTime": start_iso,
                    "endDateTime": end_iso,
                    "$top": str(n),
                    "$orderby": "start/dateTime",
                    # `id` is selected so two entries that look identical can be told apart.
                    # Live 2026-08-21 this returned five rows reading "STEST11" with the SAME
                    # start and end, which is indistinguishable from the tool repeating itself.
                    # They are five separate calendar entries; without an id the agent cannot
                    # say so, and deduping them would DELETE real events from the answer.
                    "$select": "id,subject,start,end,isAllDay,organizer,attendees,location,"
                               "isOnlineMeeting,onlineMeeting,seriesMasterId",
                },
            )
        except Exception as e:  # noqa: BLE001
            return _err(e, "Outlook calendar read failed")

        events = []
        for ev in data.get("value", []):
            org = ((ev.get("organizer") or {}).get("emailAddress") or {})
            events.append({
                "subject": ev.get("subject") or "(no subject)",
                "start": (ev.get("start") or {}).get("dateTime"),
                "end": (ev.get("end") or {}).get("dateTime"),
                "timeZone": (ev.get("start") or {}).get("timeZone"),
                "isAllDay": bool(ev.get("isAllDay")),
                "organizer": org.get("address") or org.get("name") or "",
                "attendees": [
                    ((a.get("emailAddress") or {}).get("address") or "")
                    for a in (ev.get("attendees") or [])
                ][:25],
                "location": ((ev.get("location") or {}).get("displayName") or ""),
                "isOnlineMeeting": bool(ev.get("isOnlineMeeting")),
                "joinUrl": ((ev.get("onlineMeeting") or {}).get("joinUrl") or ""),
                # Present on an expanded occurrence of a recurring series, absent on a
                # one-off. Surfaced so the agent can say "part of a recurring series"
                # instead of implying every occurrence was scheduled individually.
                "recurring": bool(ev.get("seriesMasterId")),
                # The occurrence's own id. Distinct ids on same-subject, same-time rows are the
                # proof that they are distinct events rather than one event listed repeatedly.
                "id": ev.get("id") or "",
            })
        # Same subject AND same start, on different ids, is a real and confusing situation: the
        # mailbox genuinely holds duplicates. Say so, rather than leaving the reader to assume
        # the tool malfunctioned — and never silently collapse them, which would drop events
        # the calendar really contains.
        seen: dict = {}
        for e in events:
            seen.setdefault((e["subject"], e["start"]), []).append(e["id"])
        duplicated = [
            {"subject": k[0], "start": k[1], "copies": len(v)}
            for k, v in seen.items()
            if len(v) > 1
        ]
        out = {
            "mailbox": _mailbox(),
            "range": {"start": start_iso, "end": end_iso},
            "events": events,
            "count": len(events),
        }
        if duplicated:
            out["duplicateEntries"] = duplicated
            out["note"] = (
                "Some entries share a subject and start time but are separate calendar events "
                "(see duplicateEntries and the distinct `id` on each). They are listed "
                "individually because the calendar really contains them."
            )
        return out

    return [
        outlook_search_messages,
        outlook_read_message,
        outlook_list_folders,
        outlook_list_calendar_events,
        outlook_get_attachment,
        outlook_create_draft,
        outlook_send_draft,
        outlook_send_message,
        outlook_reply_to_message,
        outlook_forward_message,
        outlook_move_message,
        outlook_delete_message,
        outlook_flag_message,
        outlook_mark_read,
        outlook_set_categories,
    ]
