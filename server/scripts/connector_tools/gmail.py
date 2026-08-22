"""Gmail live tools — the Google-side equivalent of Copilot's Office 365 Outlook
connector.

This is the first CROSS-VENDOR tool module in the codebase. Every other connector binds a
Copilot operation to the SAME vendor's API (Jira -> Jira); here a Copilot agent that read
Outlook mail is migrated to one that reads Gmail. The intent survives, the semantics do not
map one-to-one, and the places they diverge are documented on each tool rather than hidden:

  * Outlook messages live in exactly ONE folder. Gmail messages carry MANY labels. A
    "which folder is this in" question has no single answer here.
  * Outlook flags carry state and a due date. Gmail's equivalent is a boolean STARRED
    label. Information is dropped, not translated.

READ ONLY, deliberately. Sending, replying and forwarding are irreversible outward actions
taken in a real person's name, and whether a migrated agent should be able to do that at all
is a product decision, not a code one. Adding a send tool here would quietly answer it.

IDENTITY, and why it matters: these tools reach a mailbox through Domain-Wide Delegation
with a single impersonated subject (`impersonate_email`). In Copilot, an Outlook connector
in Invoker mode read the CALLER's mail as the caller. A deployed Gemini agent holds one
identity, so "summarise my inbox" means the impersonated account's inbox for every user
except that one person. Every response therefore carries `mailbox`, so an answer can never
silently appear to be about the reader's own mail. Confirmed reachable live 2026-08-19:
DWD + gmail.readonly for zara@storefuze.com returned real message ids.

See connector_tools/google_drive.py for the shared build_tools contract.
"""

API = "https://gmail.googleapis.com/gmail/v1/users/me"

# One call must never hand back a wall of mail. These caps are for the MODEL's benefit as
# much as the API's: a 200-message dump buries the answer and burns the context window.
MAX_RESULTS = 25
DEFAULT_RESULTS = 10
MAX_BODY_CHARS = 20000

def build_tools(conn, secret, mint_token, auth_header, fill):
    # Helpers live INSIDE build_tools deliberately, matching every other connector module
    # (confluence, google_drive, jira, sharepoint, generic_rest — none defines a helper at
    # module level). cloudpickle serialises these nested functions BY VALUE into the
    # Reasoning Engine pickle. A MODULE-LEVEL helper would instead be pickled BY REFERENCE
    # as `connector_tools.gmail._walk_parts`, and the container cannot resolve that at
    # unpickle time: the whole engine then fails to start with
    #   ModuleNotFoundError: No module named 'connector_tools'
    # and serves no traffic at all. Confirmed live 2026-08-19 on reasoningEngine
    # 3968754840422580224, which failed exactly this way before the helpers were nested.

    def _decode_b64url(data: str) -> str:
        """Gmail encodes body bytes base64url WITHOUT padding. Restore it before decoding."""
        import base64

        if not data:
            return ""
        try:
            return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 — a body we cannot decode must not kill the whole read
            return ""


    def _strip_html(html: str) -> str:
        """Crude tag strip, used only when a message has no text/plain part at all.

        Not a parser and not trying to be. An HTML-only marketing mail rendered perfectly is
        worth nothing here; the goal is that the model sees the words rather than the markup.
        """
        import re
        import html as _html

        text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
        text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", text)
        text = re.sub(r"(?s)<[^>]+>", " ", text)
        text = _html.unescape(text)
        text = re.sub(r"[ \t\r\f\v]+", " ", text)
        return re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()


    def _walk_parts(payload: dict) -> tuple:
        """Return (plain_text, html_text) found anywhere in a MIME tree.

        Gmail nests parts arbitrarily (multipart/alternative inside multipart/mixed, and so on),
        so this recurses rather than assuming the two-part shape most mail happens to use.
        """
        plain, html = "", ""
        mime = payload.get("mimeType", "") or ""
        body = payload.get("body", {}) or {}
        data = body.get("data", "")

        if data:
            if mime.startswith("text/plain") and not plain:
                plain = _decode_b64url(data)
            elif mime.startswith("text/html") and not html:
                html = _decode_b64url(data)

        for part in payload.get("parts", []) or []:
            p, h = _walk_parts(part)
            plain = plain or p
            html = html or h
            if plain and html:
                break
        return plain, html


    def _headers_of(msg: dict) -> dict:
        """Flatten Gmail's [{name, value}] header list into a case-insensitive lookup."""
        out = {}
        for h in (msg.get("payload", {}) or {}).get("headers", []) or []:
            name = (h.get("name") or "").lower()
            if name:
                out[name] = h.get("value") or ""
        return out

    def _mailbox() -> str:
        """Whose mailbox these tools actually read. Reported on every response."""
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
            # doseq=True is load-bearing: `metadataHeaders` is a REPEATED query parameter.
            # Without it urlencode stringifies the list into its Python repr
            # (`metadataHeaders=%5B%27From%27...`), Gmail matches no header names, and every
            # search result comes back with an empty from/subject/date while
            # gmail_read_message on the SAME id returns them correctly. Found live 2026-08-19.
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=25) as resp:
            return _json.loads(resp.read().decode("utf-8"))

    def _write(path: str, body: dict, token: str, method: str = "POST") -> dict:
        """POST/PUT against the Gmail API. Separate from _get because every caller of this
        CHANGES something in a real person's mailbox."""
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

    def _mime(to: str, subject: str, body: str, cc: str = "", bcc: str = "",
              in_reply_to: str = "", references: str = "") -> str:
        """Build an RFC-2822 message, base64url encoded, the way Gmail's `raw` field wants.

        Outlook's connector took structured fields (to/subject/body). Gmail takes a whole
        MIME message the caller assembles, which is the single biggest shape difference
        between the two APIs — the equivalence table records it as the reason SendEmailV2 is
        `narrowed` rather than `exact`.
        """
        import base64
        from email.message import EmailMessage

        msg = EmailMessage()
        msg["To"] = to
        if cc:
            msg["Cc"] = cc
        if bcc:
            msg["Bcc"] = bcc
        msg["Subject"] = subject
        if in_reply_to:
            # Gmail threading is HEADER based. Without these two the reply shows up as a
            # brand-new conversation even when threadId is set on the request.
            msg["In-Reply-To"] = in_reply_to
            msg["References"] = references or in_reply_to
        msg.set_content(body or "")
        return base64.urlsafe_b64encode(msg.as_bytes()).decode()

    def gmail_search_messages(query: str = "", max_results: int = DEFAULT_RESULTS) -> dict:
        """Search the mailbox and return matching emails with their sender, subject and date.

        Use this to answer questions about someone's email, for example "did the invoice from
        Acme arrive", "what did Priya send last week", or "any unread mail about the audit".

        Args:
            query: a Gmail search query. Supports the same syntax as the Gmail search box:
                `from:priya@acme.com`, `subject:invoice`, `is:unread`, `has:attachment`,
                `newer_than:7d`, `label:important`, and plain words for a full-text match.
                Leave empty to get the most recent messages in the mailbox.
            max_results: how many messages to return, 1-25. Defaults to 10.

        Returns:
            dict with `mailbox` (whose mail this is), `messages` (id, threadId, from, to,
            subject, date, snippet, unread), `count`, and `truncated`, or `error`.
        """
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}

        try:
            want = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
        except (TypeError, ValueError):
            want = DEFAULT_RESULTS

        params = {"maxResults": str(want)}
        if query:
            params["q"] = query

        try:
            listing = _get("/messages", params, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail search failed: {e}"}

        ids = [m.get("id") for m in listing.get("messages", []) or [] if m.get("id")]
        if not ids:
            return {
                "mailbox": _mailbox(),
                "messages": [],
                "count": 0,
                "truncated": False,
                "note": f"No messages matched{' the query ' + repr(query) if query else ''}.",
            }

        # messages.list returns ids ONLY. An id list cannot answer any real question, so each
        # message is hydrated with its headers. metadata format keeps this cheap — it skips
        # the body, which gmail_read_message fetches on demand.
        messages = []
        for mid in ids:
            try:
                msg = _get(
                    f"/messages/{mid}",
                    {
                        "format": "metadata",
                        "metadataHeaders": ["From", "To", "Subject", "Date"],
                    },
                    token,
                )
            except Exception:  # noqa: BLE001 — one unreadable message must not lose the rest
                continue
            h = _headers_of(msg)
            messages.append({
                "id": msg.get("id"),
                "threadId": msg.get("threadId"),
                "from": h.get("from", ""),
                "to": h.get("to", ""),
                "subject": h.get("subject", "(no subject)"),
                "date": h.get("date", ""),
                "snippet": msg.get("snippet", ""),
                "unread": "UNREAD" in (msg.get("labelIds") or []),
            })

        return {
            "mailbox": _mailbox(),
            "query": query,
            "messages": messages,
            "count": len(messages),
            "truncated": bool(listing.get("nextPageToken")),
        }

    def gmail_read_message(message_id: str) -> dict:
        """Read the full text of one email, so you can answer questions about what it says.

        Get a message_id from gmail_search_messages first.

        Args:
            message_id: the message id returned by gmail_search_messages.

        Returns:
            dict with `mailbox`, `from`, `to`, `cc`, `subject`, `date`, `body` (plain text),
            `labels`, `attachments` (filenames only — attachment CONTENT is not read),
            and `truncated`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required. Call gmail_search_messages first."}

        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}

        try:
            msg = _get(f"/messages/{message_id}", {"format": "full"}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail read failed for {message_id}: {e}"}

        h = _headers_of(msg)
        payload = msg.get("payload", {}) or {}
        plain, html = _walk_parts(payload)
        body = plain or (_strip_html(html) if html else "")

        # Attachment NAMES are listed but never fetched. Saying "there is an attachment
        # called contract.pdf" is honest and useful; silently omitting it would let the model
        # answer "the email contains nothing else" when it plainly does.
        attachments = []
        def _collect(p):
            if p.get("filename"):
                attachments.append(p["filename"])
            for sub in p.get("parts", []) or []:
                _collect(sub)
        _collect(payload)

        truncated = len(body) > MAX_BODY_CHARS
        result = {
            "mailbox": _mailbox(),
            "id": msg.get("id"),
            "threadId": msg.get("threadId"),
            "from": h.get("from", ""),
            "to": h.get("to", ""),
            "cc": h.get("cc", ""),
            "subject": h.get("subject", "(no subject)"),
            "date": h.get("date", ""),
            "labels": msg.get("labelIds", []),
            "attachments": attachments,
            "body": body[:MAX_BODY_CHARS],
            "truncated": truncated,
        }
        if not body:
            result["note"] = "This message has no readable text body (it may be attachment-only)."
        if truncated:
            result["note"] = f"Body was cut off at {MAX_BODY_CHARS} characters."
        return result

    def gmail_list_labels() -> dict:
        """List the labels in the mailbox — Gmail's equivalent of Outlook folders and categories.

        Useful when the user asks about a named folder or category, so you can find the label
        to use in a `label:` search query.

        Returns:
            dict with `mailbox`, `labels` (id, name, type), `count`, or `error`.

        Note: an Outlook message sits in exactly ONE folder, while a Gmail message can carry
        several labels at once. Do not present a label as if it were an exclusive folder.
        """
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}

        try:
            data = _get("/labels", {}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail label list failed: {e}"}

        labels = [
            {"id": l.get("id"), "name": l.get("name"), "type": l.get("type")}
            for l in data.get("labels", []) or []
        ]
        return {"mailbox": _mailbox(), "labels": labels, "count": len(labels)}

    # ---------------------------------------------------------------------------------
    # WRITE TOOLS.
    #
    # Everything below CHANGES a real person's mailbox, and sending is not undoable. Each
    # send/reply/forward docstring therefore tells the model to confirm with the user first
    # — the tool cannot enforce that, but an instruction the model reliably follows is worth
    # more than no guard at all. Deletion is mapped to TRASH, never permanent delete.
    #
    # Requires the `gmail.modify` scope, not `gmail.readonly`. If the Workspace DWD grant
    # lists only readonly, every tool below fails with `unauthorized_client` at mint time
    # while the read tools keep working — a confusing half-broken agent. The connector spec
    # sets the scope; the grant must match it exactly (scope strings are matched literally).
    # ---------------------------------------------------------------------------------

    def gmail_send_message(to: str, subject: str, body: str, cc: str = "", bcc: str = "") -> dict:
        """Send a NEW email. This is irreversible — the message cannot be recalled.

        ALWAYS show the user the recipient, subject and body and get their explicit
        agreement before calling this. Never send on a guess about what they meant.

        Args:
            to: recipient address, or several separated by commas.
            subject: the subject line.
            body: plain-text body.
            cc: optional cc addresses, comma separated.
            bcc: optional bcc addresses, comma separated.

        Returns:
            dict with `sent` true, `id`, `threadId`, `to`, `subject`, or `error`.
        """
        if not to:
            return {"error": "a recipient (to) is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            sent = _write("/messages/send", {"raw": _mime(to, subject, body, cc, bcc)}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail send failed: {e}"}
        return {
            "sent": True, "mailbox": _mailbox(), "id": sent.get("id"),
            "threadId": sent.get("threadId"), "to": to, "subject": subject,
        }

    def gmail_reply_to_message(message_id: str, body: str, reply_all: bool = False) -> dict:
        """Reply to an email, keeping it in the same conversation. Irreversible.

        ALWAYS show the user what you intend to say and get their agreement first.

        Args:
            message_id: the message to reply to, from gmail_search_messages.
            body: your plain-text reply.
            reply_all: include everyone on the original (to and cc), not just the sender.

        Returns:
            dict with `sent` true, `id`, `threadId`, `to`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            original = _get(f"/messages/{message_id}",
                            {"format": "metadata",
                             "metadataHeaders": ["From", "To", "Cc", "Subject", "Message-ID", "References"]},
                            token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"could not read the message being replied to: {e}"}

        h = _headers_of(original)
        subject = h.get("subject", "")
        if not subject.lower().startswith("re:"):
            subject = f"Re: {subject}"
        to = h.get("from", "")
        if reply_all:
            extra = ", ".join(x for x in (h.get("to", ""), h.get("cc", "")) if x)
            to = ", ".join(x for x in (to, extra) if x)

        raw = _mime(to, subject, body,
                    in_reply_to=h.get("message-id", ""), references=h.get("references", ""))
        try:
            sent = _write("/messages/send",
                          {"raw": raw, "threadId": original.get("threadId")}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail reply failed: {e}"}
        return {"sent": True, "mailbox": _mailbox(), "id": sent.get("id"),
                "threadId": sent.get("threadId"), "to": to, "subject": subject}

    def gmail_forward_message(message_id: str, to: str, comment: str = "") -> dict:
        """Forward an email to someone else. Irreversible.

        ALWAYS confirm the recipient with the user first — forwarding sends the ORIGINAL
        message content to a new person, which can disclose information they should not see.

        NOTE: attachments are NOT carried over. Gmail has no forward primitive, so the
        message is re-composed from its text; say so if the original had attachments.

        Args:
            message_id: the message to forward.
            to: who to forward it to.
            comment: optional note added above the forwarded text.

        Returns:
            dict with `sent` true, `attachmentsDropped`, or `error`.
        """
        if not message_id or not to:
            return {"error": "message_id and to are both required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            original = _get(f"/messages/{message_id}", {"format": "full"}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"could not read the message being forwarded: {e}"}

        h = _headers_of(original)
        plain, html = _walk_parts(original.get("payload", {}) or {})
        text = plain or (_strip_html(html) if html else "")
        subject = h.get("subject", "")
        if not subject.lower().startswith("fwd:"):
            subject = f"Fwd: {subject}"

        dropped = []
        def _names(p):
            if p.get("filename"):
                dropped.append(p["filename"])
            for sub in p.get("parts", []) or []:
                _names(sub)
        _names(original.get("payload", {}) or {})

        quoted = (
            f"{comment}\n\n" if comment else ""
        ) + (
            f"---------- Forwarded message ----------\n"
            f"From: {h.get('from','')}\nDate: {h.get('date','')}\n"
            f"Subject: {h.get('subject','')}\nTo: {h.get('to','')}\n\n{text[:MAX_BODY_CHARS]}"
        )
        try:
            sent = _write("/messages/send", {"raw": _mime(to, subject, quoted)}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail forward failed: {e}"}
        result = {"sent": True, "mailbox": _mailbox(), "id": sent.get("id"), "to": to,
                  "subject": subject, "attachmentsDropped": dropped}
        if dropped:
            result["note"] = (
                f"The original had {len(dropped)} attachment(s) ({', '.join(dropped[:3])}) "
                "which were NOT forwarded — Gmail requires re-uploading them. Tell the user."
            )
        return result

    def gmail_create_draft(to: str, subject: str, body: str, cc: str = "") -> dict:
        """Write an email and SAVE IT AS A DRAFT without sending it.

        Prefer this over gmail_send_message when the user has not clearly asked for the mail
        to go out — a draft is reversible, a sent message is not.

        Returns:
            dict with `draftId`, `messageId`, or `error`.
        """
        if not to:
            return {"error": "a recipient (to) is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            d = _write("/drafts", {"message": {"raw": _mime(to, subject, body, cc)}}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail draft creation failed: {e}"}
        return {"created": True, "mailbox": _mailbox(), "draftId": d.get("id"),
                "messageId": (d.get("message") or {}).get("id"), "to": to, "subject": subject}

    def gmail_update_draft(draft_id: str, to: str, subject: str, body: str, cc: str = "") -> dict:
        """Replace the contents of an existing draft. Not sent.

        Gmail replaces the whole draft, so pass every field you want it to end up with, not
        just the ones you are changing.

        Returns:
            dict with `updated` true and `draftId`, or `error`.
        """
        if not draft_id:
            return {"error": "draft_id is required. Call gmail_list_drafts first."}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            d = _write(f"/drafts/{draft_id}",
                       {"message": {"raw": _mime(to, subject, body, cc)}}, token, method="PUT")
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail draft update failed: {e}"}
        return {"updated": True, "mailbox": _mailbox(), "draftId": d.get("id"),
                "to": to, "subject": subject}

    def gmail_list_drafts() -> dict:
        """List the saved drafts in the mailbox, so you can find a draft id to send or edit.

        Returns:
            dict with `drafts` (draftId, to, subject), `count`, or `error`.
        """
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            listing = _get("/drafts", {"maxResults": str(MAX_RESULTS)}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail draft list failed: {e}"}

        drafts = []
        for d in listing.get("drafts", []) or []:
            mid = (d.get("message") or {}).get("id")
            info = {"draftId": d.get("id"), "messageId": mid}
            if mid:
                try:
                    m = _get(f"/messages/{mid}",
                             {"format": "metadata", "metadataHeaders": ["To", "Subject"]}, token)
                    hh = _headers_of(m)
                    info["to"] = hh.get("to", "")
                    info["subject"] = hh.get("subject", "(no subject)")
                except Exception:  # noqa: BLE001 — one unreadable draft must not lose the list
                    pass
            drafts.append(info)
        return {"mailbox": _mailbox(), "drafts": drafts, "count": len(drafts)}

    def gmail_send_draft(draft_id: str) -> dict:
        """Send a draft that already exists. Irreversible.

        ALWAYS read the draft back to the user and get their agreement before sending.

        Returns:
            dict with `sent` true, `id`, `threadId`, or `error`.
        """
        if not draft_id:
            return {"error": "draft_id is required. Call gmail_list_drafts first."}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            sent = _write("/drafts/send", {"id": draft_id}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail draft send failed: {e}"}
        return {"sent": True, "mailbox": _mailbox(), "id": sent.get("id"),
                "threadId": sent.get("threadId")}

    def gmail_trash_message(message_id: str) -> dict:
        """Move an email to Trash. Recoverable for 30 days.

        This is the equivalent of Outlook's "Delete email". It does NOT permanently erase
        the message, deliberately — an agent destroying mail irreversibly is a worse outcome
        than the small fidelity difference. There is no permanent-delete tool here.

        Returns:
            dict with `trashed` true and `id`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            m = _write(f"/messages/{message_id}/trash", {}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail trash failed: {e}"}
        return {"trashed": True, "mailbox": _mailbox(), "id": m.get("id"),
                "note": "Moved to Trash, recoverable for 30 days. Not permanently deleted."}

    def gmail_modify_labels(message_id: str, add_labels: str = "", remove_labels: str = "") -> dict:
        """Add or remove labels on an email — Gmail's equivalent of moving it to a folder or
        assigning it a category.

        IMPORTANT difference from Outlook: an Outlook message sits in exactly ONE folder, but
        a Gmail message can carry MANY labels at once. Adding a label does NOT remove the
        others. To imitate an Outlook "move", add the new label AND remove the old one (often
        `INBOX`) in the same call.

        Args:
            message_id: the message to change.
            add_labels: label IDs to add, comma separated (from gmail_list_labels).
            remove_labels: label IDs to remove, comma separated.

        Returns:
            dict with `modified` true and the resulting `labels`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        add = [x.strip() for x in (add_labels or "").split(",") if x.strip()]
        rem = [x.strip() for x in (remove_labels or "").split(",") if x.strip()]
        if not add and not rem:
            return {"error": "give at least one label to add or remove"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            m = _write(f"/messages/{message_id}/modify",
                       {"addLabelIds": add, "removeLabelIds": rem}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail label change failed: {e}"}
        return {"modified": True, "mailbox": _mailbox(), "id": m.get("id"),
                "labels": m.get("labelIds", []), "added": add, "removed": rem}

    def gmail_star_message(message_id: str, starred: bool = True) -> dict:
        """Star or unstar an email — the closest Gmail has to Outlook's flag.

        NOTE: an Outlook flag carries a state and a DUE DATE. A Gmail star is only on or off.
        If the user asks for a follow-up date, tell them that cannot be stored here.

        Returns:
            dict with `starred` and `id`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        body = ({"addLabelIds": ["STARRED"]} if starred else {"removeLabelIds": ["STARRED"]})
        try:
            m = _write(f"/messages/{message_id}/modify", body, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail star change failed: {e}"}
        return {"starred": bool(starred), "mailbox": _mailbox(), "id": m.get("id"),
                "labels": m.get("labelIds", [])}

    def gmail_mark_read(message_id: str, read: bool = True) -> dict:
        """Mark an email as read or unread.

        Args:
            message_id: the message to change.
            read: True marks it read, False marks it unread.

        Returns:
            dict with `read` and `id`, or `error`.
        """
        if not message_id:
            return {"error": "message_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        # Gmail models unread as the PRESENCE of the UNREAD label, so "mark read" removes it.
        body = ({"removeLabelIds": ["UNREAD"]} if read else {"addLabelIds": ["UNREAD"]})
        try:
            m = _write(f"/messages/{message_id}/modify", body, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Gmail read-state change failed: {e}"}
        return {"read": bool(read), "mailbox": _mailbox(), "id": m.get("id"),
                "labels": m.get("labelIds", [])}

    def gmail_get_attachment(message_id: str, filename: str = "") -> dict:
        """Read the TEXT content of an attachment on an email.

        Only plain-text formats are readable (txt, csv, json, md). Binary formats such as
        PDF, Word and Excel are reported with their size but NOT decoded — say so rather
        than guessing at their contents.

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
            msg = _get(f"/messages/{message_id}", {"format": "full"}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"could not read the message: {e}"}

        found = []
        def _collect(p):
            if p.get("filename"):
                found.append({
                    "filename": p["filename"],
                    "mimeType": p.get("mimeType", ""),
                    "size": (p.get("body", {}) or {}).get("size", 0),
                    "attachmentId": (p.get("body", {}) or {}).get("attachmentId"),
                })
            for sub in p.get("parts", []) or []:
                _collect(sub)
        _collect(msg.get("payload", {}) or {})

        if not found:
            return {"mailbox": _mailbox(), "attachments": [], "count": 0,
                    "note": "This message has no attachments."}
        if not filename:
            return {"mailbox": _mailbox(),
                    "attachments": [{k: v for k, v in a.items() if k != "attachmentId"} for a in found],
                    "count": len(found),
                    "note": "Call again with a filename to read one of these."}

        match = next((a for a in found if a["filename"].lower() == filename.lower()), None)
        if not match:
            return {"error": f"no attachment named {filename!r}. Available: "
                             f"{', '.join(a['filename'] for a in found)}"}

        readable = ("text/", "application/json", "application/xml")
        if not any(match["mimeType"].startswith(t) for t in readable):
            return {"mailbox": _mailbox(), "filename": match["filename"],
                    "mimeType": match["mimeType"], "size": match["size"], "content": None,
                    "note": "This is a binary format and its contents were NOT read. "
                            "Do not describe what it contains."}
        try:
            att = _get(f"/messages/{message_id}/attachments/{match['attachmentId']}", {}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"attachment download failed: {e}"}
        text = _decode_b64url(att.get("data", ""))
        return {"mailbox": _mailbox(), "filename": match["filename"],
                "mimeType": match["mimeType"], "size": match["size"],
                "content": text[:MAX_BODY_CHARS], "truncated": len(text) > MAX_BODY_CHARS}

    # READ tools first — the model reaches for what it sees earliest, and reading before
    # writing is the safer default when a request is ambiguous.
    return [
        gmail_search_messages,
        gmail_read_message,
        gmail_list_labels,
        gmail_get_attachment,
        gmail_create_draft,
        gmail_update_draft,
        gmail_list_drafts,
        gmail_send_draft,
        gmail_send_message,
        gmail_reply_to_message,
        gmail_forward_message,
        gmail_trash_message,
        gmail_modify_labels,
        gmail_star_message,
        gmail_mark_read,
    ]
