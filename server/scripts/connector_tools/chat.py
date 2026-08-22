"""Google Chat tools — the cross-vendor destination for Copilot's Microsoft Teams connector.

Second cross-vendor mapping after gmail.py. A migrated agent that used to post and read
Teams messages gets these instead.

WHY EVERY HELPER IS NESTED INSIDE build_tools: cloudpickle serialises a nested closure BY
VALUE but a module-level function BY REFERENCE. A module-level helper is pickled as
`connector_tools.chat._fn`, which the Reasoning Engine container cannot import — the engine
then fails to START, with no tool ever running. Cost a full deploy cycle to learn on
gmail.py (ledger 1.45). Keep them nested.

IDENTITY — the part that differs from Gmail. Chat has two auth models and this file supports
both through one code path:
  * impersonate_email SET   -> domain-wide delegation, the agent acts as that person.
    PROVEN for READS (2026-08-20): DWD mints Chat tokens and spaces.list/messages.list
    return that user's real spaces and messages. Some WRITES are a different story — see
    the measured block below; spaces.create refuses user auth.
  * impersonate_email UNSET -> the service account acts as a registered CHAT APP. The app
    must be a member of every space it touches, and messages are visibly posted by the app
    rather than by a person.
The only difference at runtime is whether `_mint_token` was given a subject, so nothing here
branches on it. If DWD turns out unsupported, this file still works — as an app.

WHAT DOES NOT CARRY OVER, and is not faked here:
  * Team -> Channel hierarchy. Chat is flat: one Space, no parent. `chat_list_spaces`
    returns spaces with no grouping, because there is no grouping to return.
  * Interactive cards and Teams task modules. Posting a card works. A card the user can
    CLICK needs an app receiving callback events; a deployed agent is a tool caller, not a
    hosted service. No tool here pretends otherwise.
  * Recordings, transcripts and AI insights. Those are Google Meet API, not Chat.

MEASURED 2026-08-20 impersonating a real user under DWD, BEFORE any deploy:
    spaces.list                    PASS  25 spaces
    spaces.messages.list           PASS  5 messages
    spaces.messages.get            PASS
    thread replies                 PASS
    spaces.members.list            403   needs chat.memberships.readonly (scope was missing)
    spaces.create                  404   "Google Chat app not found"
    spaces:findDirectMessage       404   same
    spaces.messages.create         404   "Google Chat app not found" — posting into a real
                                         space (practice_1504) as an impersonated user

WRITES REQUIRE A CONFIGURED CHAT APP, and that is not a scope. Chat message creation needs
the Cloud project to have a Chat app configured (Chat API -> Configuration); reads do not.
Once configured, messages post AS THE APP and everyone in the space sees that, which is a
product difference, not a detail. Until a customer configures one, this connector is
READ-CAPABLE ONLY — same practical shape as keep-Teams, arrived at for a different reason.

Space NAMES resolve to ids (`practice_1504` -> `spaces/AAQAMx3E6AU`, verified), because
people know names and not ids. An ambiguous or unknown name is REFUSED, never guessed:
posting into the wrong space is visible to the wrong people.
"""

API = "https://chat.googleapis.com/v1"
MAX_RESULTS = 50
DEFAULT_RESULTS = 25
MAX_BODY_CHARS = 20000


def build_tools(conn, secret, mint_token, auth_header, fill):
    import json
    import urllib.error
    import urllib.parse
    import urllib.request

    def _token():
        return mint_token(fill)

    def _me():
        try:
            return secret("impersonate_email") or "(the Chat app)"
        except Exception:  # noqa: BLE001 — optional field
            return "(the Chat app)"

    def _err(prefix, e):
        """Chat puts the real reason in the response body, so read it before giving up.

        A bare 403 is ambiguous between "no scope", "the app is not in this space" and "DWD
        is not permitted for Chat" — three different fixes. The body distinguishes them, so
        it is surfaced rather than swallowed.
        """
        detail = ""
        body = getattr(e, "read", None)
        if body:
            try:
                detail = body().decode("utf-8", "replace")[:400]
            except Exception:  # noqa: BLE001
                detail = ""
        code = getattr(e, "code", "")
        return {"error": f"{prefix} failed ({code}): {detail or e}"}

    def _call(method, path, params=None, body=None):
        url = f"{API}{path}"
        if params:
            # doseq=True is load-bearing for any repeated query parameter, the same bug that
            # silently emptied every Gmail search result (ledger 1.45).
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Authorization": f"Bearer {_token()}"}
        if data:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw) if raw.strip() else {}

    def _all_spaces():
        """Every space, following pageToken. Needed because a name lookup that only sees the
        first page silently "cannot find" a space that exists."""
        spaces, token, pages = [], None, 0
        while pages < 10:
            params = {"pageSize": 100}
            if token:
                params["pageToken"] = token
            out = _call("GET", "/spaces", params)
            spaces.extend(out.get("spaces") or [])
            token = out.get("nextPageToken")
            pages += 1
            if not token:
                break
        return spaces

    def _resolve_space(value):
        """Turn what a PERSON says into a space resource name.

        People know space NAMES ("practice_1504"), not ids ("spaces/AAQAMx3E6AU"), and an
        agent is told about spaces in the same words its user uses. Requiring an id forced
        every caller through chat_list_spaces first and broke whenever the space was past the
        first page.

        Returns (resourceName, errorDict). Exactly one of the two is set.

        AMBIGUITY IS AN ERROR, NOT A GUESS. Two spaces called "General" and a tool that picks
        the first one posts a message into the wrong room, visibly, to the wrong people. The
        caller is told the candidates instead.
        """
        v = (value or "").strip()
        if not v:
            return "", {"error": "space is required — give the space name or id. Call chat_list_spaces to see them."}
        if v.startswith("spaces/"):
            return v, None

        try:
            spaces = _all_spaces()
        except Exception as e:  # noqa: BLE001
            return "", _err("Chat space lookup", e)

        exact = [s for s in spaces if (s.get("displayName") or "").strip() == v]
        if len(exact) == 1:
            return exact[0].get("name", ""), None
        if len(exact) > 1:
            return "", {
                "error": f'"{v}" matches {len(exact)} spaces. Use the id instead: '
                + ", ".join(s.get("name", "") for s in exact[:5]),
            }

        ci = [s for s in spaces if (s.get("displayName") or "").strip().lower() == v.lower()]
        if len(ci) == 1:
            return ci[0].get("name", ""), None
        if len(ci) > 1:
            return "", {
                "error": f'"{v}" matches {len(ci)} spaces differing only in case. Use the id: '
                + ", ".join(s.get("name", "") for s in ci[:5]),
            }

        partial = [s for s in spaces if v.lower() in (s.get("displayName") or "").lower()]
        if len(partial) == 1:
            return partial[0].get("name", ""), None
        if len(partial) > 1:
            return "", {
                "error": f'"{v}" is ambiguous — did you mean: '
                + ", ".join(f'{s.get("displayName")} ({s.get("name")})' for s in partial[:5]),
            }

        # No name matched. An earlier version treated any single word as a bare id and built
        # "spaces/<word>", which turned a typo into a malformed-resource 400 instead of a
        # clear "no such space" (measured: "zzz-no-such-space-zzz" produced a 400). A bare id
        # is indistinguishable from a name, so it is refused: pass the full resource name.
        return "", {
            "error": f'No space named "{v}" among the {len(spaces)} this agent can see. '
            f'Call chat_list_spaces for the names, or pass the full resource name '
            f'("spaces/AAAA...") if you have the id.'
        }

    def _space_name(space_id):
        """Back-compat shim for the read paths that already hold a resource name."""
        s = (space_id or "").strip()
        if not s:
            return ""
        return s if s.startswith("spaces/") else f"spaces/{s}"

    def _msg_name(message_id, space_id=None):
        m = (message_id or "").strip()
        if m.startswith("spaces/"):
            return m
        sp = _space_name(space_id)
        return f"{sp}/messages/{m}" if sp and m else m

    def _trim(text):
        t = text or ""
        return t if len(t) <= MAX_BODY_CHARS else t[:MAX_BODY_CHARS] + "\n[truncated]"

    def _summarise_space(sp):
        # `spaceType` is the only signal for DM vs named room. Reported plainly rather than
        # translated into Teams vocabulary — calling a Space a "channel" would imply a
        # hierarchy that does not exist.
        return {
            "id": sp.get("name", ""),
            "name": sp.get("displayName") or "(direct message)",
            "type": sp.get("spaceType") or sp.get("type") or "",
            "threaded": bool(sp.get("spaceThreadingState") in ("THREADED_MESSAGES", "GROUPED_MESSAGES")),
        }

    def _summarise_message(m):
        # Sender naming in Chat is UNEVEN, and the first attempt at this got it wrong twice.
        #
        # Chat returns `displayName` for APP/bot senders but usually only `users/{id}` for
        # humans — resolving a human needs the Directory/People API, a scope this connector
        # deliberately does not request. The first version claimed flatly that "Google Chat
        # does not return sender names", which was false (a live message came back from
        # "Oilver workflow"), and it put that sentence in the per-message field so a deployed
        # agent printed the explanation 24 times AS the sender's name (measured 2026-08-20).
        #
        # So: report what is there, leave it empty when it is not, and explain ONCE at the
        # response level. An explanation belongs next to the answer, not inside every row.
        sender = (m.get("sender") or {}).get("name", "")
        display = (m.get("sender") or {}).get("displayName", "")
        return {
            "id": m.get("name", ""),
            "sender": sender,
            "senderDisplayName": display,
            "text": _trim(m.get("text") or ""),
            "createdAt": m.get("createTime", ""),
            "thread": (m.get("thread") or {}).get("name", ""),
            "hasCard": bool(m.get("cardsV2")),
        }

    # ---- read ---------------------------------------------------------------------------

    def chat_list_spaces(query: str = "", max_results: int = DEFAULT_RESULTS) -> dict:
        """List the Google Chat spaces (rooms and direct messages) available to this agent.

        Chat is FLAT — there is no team containing these spaces, so none is reported. If the
        source agent listed Teams channels grouped under a team, that grouping is gone.

        Args:
            query: optional text to match against space display names, case-insensitive.
            max_results: how many spaces to return (max 50).
        """
        try:
            n = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
            out = _call("GET", "/spaces", {"pageSize": n})
            spaces = [_summarise_space(s) for s in (out.get("spaces") or [])]
            q = (query or "").strip().lower()
            if q:
                spaces = [s for s in spaces if q in (s["name"] or "").lower()]
            return {"count": len(spaces), "spaces": spaces, "actingAs": _me()}
        except Exception as e:  # noqa: BLE001
            return _err("Chat space list", e)

    def chat_find_direct_message(user_email: str = "") -> dict:
        """Find the direct-message space with one person, so a message can be sent to them.

        Args:
            user_email: the person's email address in your Workspace.
        """
        email = (user_email or "").strip()
        if not email:
            return {"error": "user_email is required."}
        try:
            # `users/{email}` is accepted in place of a numeric id, which spares the agent a
            # Directory API lookup it has no scope for.
            out = _call("GET", "/spaces:findDirectMessage", {"name": f"users/{email}"})
            return {"space": _summarise_space(out), "actingAs": _me()}
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat direct-message lookup for {email}", e)

    def chat_list_messages(
        space_id: str = "", query: str = "", max_results: int = DEFAULT_RESULTS
    ) -> dict:
        """Read recent messages in a Chat space.

        This is the equivalent of "Get messages in a channel" and "Get messages in a chat" —
        Teams keeps those separate, Chat does not.

        Args:
            space_id: the space NAME as a person would say it (e.g. 'practice_1504'), or a
                resource name like 'spaces/AAAA...'. An ambiguous name is refused rather
                than guessed.
            query: optional text to match within message bodies, case-insensitive.
            max_results: how many messages to return (max 50).
        """
        sp, err = _resolve_space(space_id)
        if err:
            return err
        try:
            n = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
            out = _call("GET", f"/{sp}/messages", {"pageSize": n, "orderBy": "createTime desc"})
            msgs = [_summarise_message(m) for m in (out.get("messages") or [])]
            q = (query or "").strip().lower()
            if q:
                msgs = [m for m in msgs if q in (m["text"] or "").lower()]
            unnamed = sum(1 for m in msgs if not m["senderDisplayName"])
            out_obj = {"count": len(msgs), "space": sp, "messages": msgs}
            if unnamed:
                # Once, not per message.
                out_obj["senderNote"] = (
                    f"{unnamed} of {len(msgs)} senders have no display name — Google Chat "
                    "returns names for apps but only a user id for people. Refer to them by "
                    "id rather than guessing who they are."
                )
            return out_obj
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat message list for {sp}", e)

    def chat_get_message(message_id: str = "", space_id: str = "") -> dict:
        """Read one Chat message in full.

        Args:
            message_id: full resource name 'spaces/AAA/messages/BBB', or the bare message id
                with space_id also supplied.
            space_id: the space, only needed when message_id is a bare id.
        """
        name = _msg_name(message_id, space_id)
        if not name:
            return {"error": "message_id is required. Call chat_list_messages first."}
        try:
            return _summarise_message(_call("GET", f"/{name}"))
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat message read for {name}", e)

    def chat_list_thread_replies(
        message_id: str = "", space_id: str = "", max_results: int = DEFAULT_RESULTS
    ) -> dict:
        """List the replies in the same thread as a message.

        Chat threading is a per-SPACE setting, not a per-message choice as in Teams: in a
        space configured for unthreaded messages every message is its own thread, so this
        returns just the one message rather than failing.

        Args:
            message_id: a message in the thread.
            space_id: the space, only needed when message_id is a bare id.
        """
        name = _msg_name(message_id, space_id)
        if not name:
            return {"error": "message_id is required."}
        try:
            msg = _call("GET", f"/{name}")
            thread = (msg.get("thread") or {}).get("name", "")
            sp = name.split("/messages/")[0]
            if not thread:
                return {"count": 1, "threaded": False, "messages": [_summarise_message(msg)]}
            n = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
            out = _call(
                "GET", f"/{sp}/messages", {"pageSize": n, "filter": f'thread.name = "{thread}"'}
            )
            return {
                "count": len(out.get("messages") or []),
                "threaded": True,
                "thread": thread,
                "messages": [_summarise_message(m) for m in (out.get("messages") or [])],
            }
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat thread replies for {name}", e)

    def chat_list_members(space_id: str = "", max_results: int = DEFAULT_RESULTS) -> dict:
        """List who is in a Chat space.

        Needs the OPTIONAL scope chat.memberships.readonly. Without it this returns a 403
        naming the scope — the rest of the connector is unaffected, because that scope is
        deliberately not in the token request (including an ungranted scope breaks every
        tool, measured 2026-08-20).

        Args:
            space_id: the space name (e.g. 'practice_1504') or resource name.
            max_results: how many members to return (max 50).
        """
        sp, err = _resolve_space(space_id)
        if err:
            return err
        try:
            n = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
            out = _call("GET", f"/{sp}/members", {"pageSize": n})
            members = []
            for m in out.get("memberships") or []:
                who = m.get("member") or {}
                members.append(
                    {
                        "id": who.get("name", ""),
                        "displayName": who.get("displayName", ""),
                        "type": who.get("type", ""),
                        "role": m.get("role", ""),
                    }
                )
            return {"count": len(members), "space": sp, "members": members}
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat member list for {sp}", e)

    # ---- write --------------------------------------------------------------------------

    def chat_send_message(space_id: str = "", text: str = "") -> dict:
        """Post a message to a Chat space.

        Args:
            space_id: the space to post in — its NAME (e.g. 'practice_1504') or resource
                name. An ambiguous name is refused, never guessed, because posting into
                the wrong space is visible to everyone in it.
            text: the message body. Chat accepts a subset of Markdown (*bold*, _italic_).
        """
        sp, err = _resolve_space(space_id)
        if err:
            return err
        if not (text or "").strip():
            return {"error": "text is required — refusing to post an empty message."}
        try:
            out = _call("POST", f"/{sp}/messages", body={"text": text})
            return {
                "sent": True,
                "id": out.get("name", ""),
                "space": sp,
                "thread": (out.get("thread") or {}).get("name", ""),
                "postedAs": _me(),
            }
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat send to {sp}", e)

    def chat_reply_to_message(message_id: str = "", space_id: str = "", text: str = "") -> dict:
        """Reply in the same thread as an existing message.

        In a space configured for unthreaded messages this still posts, but as a new message
        rather than a threaded reply — Chat decides threading per space, not per message.

        Args:
            message_id: the message to reply to.
            space_id: the space, only needed when message_id is a bare id.
            text: the reply body.
        """
        name = _msg_name(message_id, space_id)
        if not name:
            return {"error": "message_id is required."}
        if not (text or "").strip():
            return {"error": "text is required — refusing to post an empty reply."}
        try:
            msg = _call("GET", f"/{name}")
            thread = (msg.get("thread") or {}).get("name", "")
            sp = name.split("/messages/")[0]
            body = {"text": text}
            params = None
            if thread:
                body["thread"] = {"name": thread}
                # Without this the API starts a NEW thread even though thread.name was given.
                params = {"messageReplyOption": "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"}
            out = _call("POST", f"/{sp}/messages", params=params, body=body)
            return {
                "sent": True,
                "id": out.get("name", ""),
                "thread": (out.get("thread") or {}).get("name", ""),
                "threaded": bool(thread),
                "postedAs": _me(),
            }
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat reply to {name}", e)

    def chat_send_card(space_id: str = "", title: str = "", text: str = "") -> dict:
        """Post a simple card (a titled, formatted block) to a Chat space.

        This is the nearest equivalent to a Teams Adaptive Card, and it is NARROWER on
        purpose: the card is DISPLAY ONLY. Buttons and forms are deliberately not offered,
        because a clickable card needs an app receiving callback events and a deployed agent
        cannot receive them. A card with a dead button is worse than no card.

        Args:
            space_id: the space name or resource name.
            title: the card header.
            text: the card body text.
        """
        sp, err = _resolve_space(space_id)
        if err:
            return err
        if not (title or "").strip() and not (text or "").strip():
            return {"error": "title or text is required."}
        card = {
            "cardId": "migrated-card",
            "card": {
                "header": {"title": title or ""},
                "sections": [{"widgets": [{"textParagraph": {"text": text or ""}}]}],
            },
        }
        try:
            out = _call("POST", f"/{sp}/messages", body={"cardsV2": [card]})
            return {
                "sent": True,
                "id": out.get("name", ""),
                "space": sp,
                "interactive": False,
                "note": "Display-only card. Adaptive Card buttons and forms do not carry over.",
                "postedAs": _me(),
            }
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat card send to {sp}", e)

    def chat_update_message(message_id: str = "", space_id: str = "", text: str = "") -> dict:
        """Edit a message this agent previously posted.

        Chat only permits editing messages the same identity created, so this cannot edit
        another person's message even when the agent can read it.

        Args:
            message_id: the message to edit.
            space_id: the space, only needed when message_id is a bare id.
            text: the replacement body.
        """
        name = _msg_name(message_id, space_id)
        if not name:
            return {"error": "message_id is required."}
        if not (text or "").strip():
            return {"error": "text is required."}
        try:
            out = _call(
                "PATCH", f"/{name}", params={"updateMask": "text"}, body={"text": text}
            )
            return {"updated": True, "id": out.get("name", name)}
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat message update for {name}", e)

    def chat_create_space(name: str = "", member_emails: str = "") -> dict:
        """Create a named Chat space, optionally adding people to it.

        This is the destination for BOTH "Create a team" and "Create a channel" — Chat has
        one flat Space object, so a team-plus-channels structure cannot be reproduced. If the
        source agent created a channel inside a team, the team part is lost.

        Args:
            name: the space's display name.
            member_emails: optional comma-separated email addresses to add.
        """
        disp = (name or "").strip()
        if not disp:
            return {"error": "name is required."}
        try:
            out = _call(
                "POST", "/spaces", body={"displayName": disp, "spaceType": "SPACE"}
            )
            space = out.get("name", "")
            added, failed = [], []
            for email in [e.strip() for e in (member_emails or "").split(",") if e.strip()]:
                try:
                    _call(
                        "POST",
                        f"/{space}/members",
                        body={"member": {"name": f"users/{email}", "type": "HUMAN"}},
                    )
                    added.append(email)
                except Exception:  # noqa: BLE001 — one bad address must not lose the space
                    failed.append(email)
            return {
                "created": True,
                "space": space,
                "name": disp,
                "membersAdded": added,
                "membersFailed": failed,
                "note": "Chat spaces are flat — there is no team above this space.",
            }
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat space creation for {disp}", e)

    # Read first, deliberately: an agent that can look before it posts is far less likely to
    # invent a space id and write into the wrong room.
    tools = [
        chat_list_spaces,
        chat_find_direct_message,
        chat_list_messages,
        chat_get_message,
        chat_list_thread_replies,
        chat_list_members,
    ]

    # WRITES ARE OFF BY DEFAULT, and this is the same rule applied to teams.py: a tool that
    # cannot succeed must not be handed to the model. Chat message creation returns 404
    # "Google Chat app not found" until the Cloud project has a Chat app configured (measured
    # 2026-08-20), and a model given a send tool that always 404s will retry, apologise, and
    # report the failure as its own.
    #
    # The flag is a stored credential rather than a code constant because it is a per-CUSTOMER
    # fact: one customer configures a Chat app, the next has not. Set `chat_app_configured` to
    # "true" once the project has one, and the write tools appear with no code change.
    try:
        configured = (secret("chat_app_configured") or "").strip().lower() in ("1", "true", "yes")
    except Exception:  # noqa: BLE001 — absent credential means not configured
        configured = False

    if configured:
        tools += [
            chat_send_message,
            chat_reply_to_message,
            chat_send_card,
            chat_update_message,
            chat_create_space,
        ]

    return tools
