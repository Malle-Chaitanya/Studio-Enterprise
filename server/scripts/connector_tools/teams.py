"""Microsoft Teams tools via Graph — the KEEP-MICROSOFT destination for Copilot's Teams
connector. The agent moves to Gemini; its Teams messaging stays in Microsoft 365.

Mirror of outlook.py: nothing is translated on this path, so the Team -> Channel hierarchy
survives intact, threads stay threads, and none of the Google Chat fidelity notes apply.

WHY EVERY HELPER IS NESTED INSIDE build_tools: cloudpickle serialises nested closures BY
VALUE and module-level functions BY REFERENCE. A module-level helper pickles as
`connector_tools.teams._fn`, which the container cannot import, and the Reasoning Engine then
fails to START (ledger 1.45). Keep them nested.

PERMISSIONS — MEASURED, not inferred (2026-08-20, tenant 807d6772, app ConnectorsTest):

    READ  channel messages   GET /teams/{id}/channels/{id}/messages     WORKS app-only
    READ  chat messages      GET /chats/{id}/messages                   WORKS app-only
    WRITE channel message    POST .../messages          403 "requires one of Teamwork.Migrate.All"
    WRITE chat message       POST /chats/{id}/messages  403 "requires one of Teamwork.Migrate.All"
    CREATE channel           POST /teams/{id}/channels  403 "requires one of Channel.Create, ..."

THIS PATH IS READ-ONLY, and not because a permission was missed. `ChannelMessage.Send` does
not EXIST as an application permission — it is delegated-only. Microsoft's only app-only
write route for Teams messages is `Teamwork.Migrate.All`, the bulk import API, which requires
the team to be in migration mode and is not a general posting grant.

Delegated auth would allow posting, but this product deliberately uses app-only
client_credentials for Microsoft (delegated resource scopes trigger AADSTS65001 — see
.claude/rules/security-rules.md). So the limit is architectural, not an oversight.

Send/reply tools are therefore NOT RETURNED. A tool that always 403s is worse than an absent
one: the model retries it, reports failure as its own fault, and the customer sees an agent
that looks broken rather than an agent honestly missing a capability.

`teams_create_channel` IS returned, because `Channel.Create` is a real application permission
the customer can grant. It fails with a clear 403 until they do.

Application permissions needed for what this file DOES offer:
    Team.ReadBasic.All, Channel.ReadBasic.All   list teams and channels
    ChannelMessage.Read.All                     read channel messages
    Chat.ReadWrite.All (or Chat.Read.All)       list and read chats
    User.Read.All                               resolve people to ids
    Channel.Create                              only for teams_create_channel

Identity: `impersonate_email` names the user whose chats the agent reads. App-only Graph
reaches every mailbox and chat in the tenant, so WHICH user is a per-agent decision and is
never inferred from the caller.
"""

GRAPH = "https://graph.microsoft.com/v1.0"
MAX_RESULTS = 50
DEFAULT_RESULTS = 20
MAX_BODY_CHARS = 20000


def build_tools(conn, secret, mint_token, auth_header, fill):
    import json
    import urllib.error
    import urllib.parse
    import urllib.request

    def _token():
        return mint_token(fill)

    def _user():
        try:
            return secret("impersonate_email") or ""
        except Exception:  # noqa: BLE001 — optional field
            return ""

    def _err(prefix, e):
        """Graph puts the real reason in the body — read it.

        `ErrorAccessDenied` alone cannot distinguish a missing application permission from
        the protected-APIs gate from an access policy. The body can. Surfacing it turned a
        guessing game into one command on the mail connector (ledger 1.46).
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
        url = f"{GRAPH}{path}"
        if params:
            # doseq=True: $expand and $select can repeat, and urlencode without it serialises
            # a list as a Python repr that Graph silently ignores (ledger 1.45).
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Authorization": f"Bearer {_token()}"}
        if data:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", "replace")
        return json.loads(raw) if raw.strip() else {}

    def _trim(text):
        t = text or ""
        return t if len(t) <= MAX_BODY_CHARS else t[:MAX_BODY_CHARS] + "\n[truncated]"

    def _strip_html(html):
        """Teams message bodies are usually HTML. The model reads text better than markup,
        and the markup is not information the agent can act on."""
        import re

        text = re.sub(r"<br\s*/?>", "\n", html or "")
        text = re.sub(r"</(p|div)>", "\n", text)
        text = re.sub(r"<[^>]+>", "", text)
        return text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").strip()

    def _event_label(m):
        """Turn Graph's eventDetail type into something a person would say.

        A Teams chat contains SYSTEM EVENTS as well as messages — call started, members
        added, chat renamed. Graph returns them with body `<systemEventMessage/>`, i.e. no
        text. Reported as ordinary messages they became "5 messages, however all of them are
        empty" from a deployed agent (measured 2026-08-20) — technically true and completely
        misleading: it reads as a broken tool rather than a chat nobody has spoken in.

        Derived from the @odata.type rather than a lookup table, so an event type Microsoft
        adds tomorrow still gets a sensible label instead of being dropped.
        """
        detail = m.get("eventDetail") or {}
        odata = str(detail.get("@odata.type") or "")
        name = odata.rsplit(".", 1)[-1].replace("EventMessageDetail", "")
        if not name:
            return "system event"
        words = []
        current = ""
        for ch in name:
            if ch.isupper() and current:
                words.append(current)
                current = ch
            else:
                current += ch
        if current:
            words.append(current)
        return " ".join(w.lower() for w in words) or "system event"

    def _summarise_message(m):
        body = m.get("body") or {}
        content = body.get("content") or ""
        text = _strip_html(content) if (body.get("contentType") == "html") else content
        frm = ((m.get("from") or {}).get("user") or {})

        # A system event has no author and no text. Saying so beats returning a blank message.
        is_event = bool(m.get("eventDetail")) or content.strip() == "<systemEventMessage/>"
        if is_event:
            return {
                "id": m.get("id", ""),
                "kind": "systemEvent",
                "event": _event_label(m),
                "text": "",
                "sender": "(system)",
                "createdAt": m.get("createdDateTime", ""),
            }

        return {
            "id": m.get("id", ""),
            "kind": "message",
            "sender": frm.get("displayName", "") or (m.get("from") or {}).get("application", {}).get("displayName", ""),
            "senderId": frm.get("id", ""),
            "text": _trim(text),
            "createdAt": m.get("createdDateTime", ""),
            "replyToId": m.get("replyToId") or "",
            "importance": m.get("importance", ""),
            "hasAttachments": bool(m.get("attachments")),
        }

    def _split_counts(items):
        """Counts a model can answer with directly, instead of inferring from a list."""
        msgs = [x for x in items if x.get("kind") == "message"]
        events = [x for x in items if x.get("kind") == "systemEvent"]
        return {
            "count": len(items),
            "messageCount": len(msgs),
            "systemEventCount": len(events),
            "note": (
                "This conversation contains only system events (people joining, calls "
                "starting) — nobody has posted a message in it."
                if items and not msgs
                else ""
            ),
        }

    def _n(v):
        return max(1, min(int(v or DEFAULT_RESULTS), MAX_RESULTS))

    # ---- structure: the hierarchy that Google Chat cannot represent ---------------------

    def teams_list_joined_teams(max_results: int = DEFAULT_RESULTS) -> dict:
        """List the Teams this agent's user belongs to.

        Args:
            max_results: how many teams to return (max 50).
        """
        user = _user()
        if not user:
            return {"error": "No user is configured for this agent — set the Teams user on the connector screen."}
        try:
            out = _call("GET", f"/users/{urllib.parse.quote(user)}/joinedTeams")
            teams = [
                {"id": t.get("id", ""), "name": t.get("displayName", ""), "description": t.get("description", "")}
                for t in (out.get("value") or [])
            ][: _n(max_results)]
            return {"count": len(teams), "teams": teams, "actingAs": user}
        except Exception as e:  # noqa: BLE001
            return _err(f"Teams list for {user}", e)

    def teams_list_channels(team_id: str = "", max_results: int = DEFAULT_RESULTS) -> dict:
        """List the channels inside a Team.

        Args:
            team_id: the team's id. Call teams_list_joined_teams first.
            max_results: how many channels to return (max 50).
        """
        if not (team_id or "").strip():
            return {"error": "team_id is required. Call teams_list_joined_teams first."}
        try:
            # $top is REJECTED on /channels ("Query option 'Top' is not allowed",
            # measured 2026-08-20) and on /joinedTeams. Slice client-side instead of
            # sending a parameter Graph 400s on.
            out = _call("GET", f"/teams/{team_id}/channels")
            chans = [
                {
                    "id": c.get("id", ""),
                    "name": c.get("displayName", ""),
                    "description": c.get("description", ""),
                    "membershipType": c.get("membershipType", ""),
                }
                for c in (out.get("value") or [])
            ][: _n(max_results)]
            return {"count": len(chans), "team": team_id, "channels": chans}
        except Exception as e:  # noqa: BLE001
            return _err(f"Channel list for team {team_id}", e)

    def teams_list_chats(max_results: int = DEFAULT_RESULTS) -> dict:
        """List this agent's user's 1:1 and group chats (not channels).

        Args:
            max_results: how many chats to return (max 50).

        Returns:
            dict with `chats` — each with `name` (the topic, or who the chat is with when a
            1:1 chat has no topic), `with` (the other participants), `type`, `lastUpdated`
            and `id` — plus `count` and `actingAs`. Quote `name`, not `id`, when telling the
            user which chat you mean.
        """
        user = _user()
        if not user:
            return {"error": "No user is configured for this agent."}
        try:
            # $expand=members, because a 1:1 chat has NO topic. Without it every such chat
            # came back as "(no topic)" and nothing else — measured 2026-08-20, a list of ten
            # chats rendered as ten identical opaque rows, so "which chat do you mean?" was
            # unanswerable. Graph resolves the participants on this same request; asking
            # per-chat afterwards would be N+1 calls for the same data.
            out = _call(
                "GET",
                f"/users/{urllib.parse.quote(user)}/chats",
                {"$top": _n(max_results), "$expand": "members"},
            )
            chats = []
            for c in (out.get("value") or []):
                others = [
                    (m.get("displayName") or m.get("email") or "").strip()
                    for m in (c.get("members") or [])
                    # Everyone EXCEPT the agent's own user — "a chat with Erik" is the useful
                    # label for Erik's agent, not "a chat with Erik and Erik".
                    if (m.get("email") or "").lower() != user.lower()
                ]
                others = [o for o in others if o]
                topic = c.get("topic") or ""
                chats.append({
                    "id": c.get("id", ""),
                    # `name` is what the model should quote: the topic when there is one, the
                    # other participants when there is not.
                    "name": topic or (", ".join(others) if others else "(unnamed chat)"),
                    "topic": topic,
                    "with": others,
                    "type": c.get("chatType", ""),
                    "lastUpdated": c.get("lastUpdatedDateTime", ""),
                })
            return {"count": len(chats), "chats": chats, "actingAs": user}
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat list for {user}", e)

    def teams_list_members(team_id: str = "", channel_id: str = "", chat_id: str = "") -> dict:
        """List who is in a team, a channel, or a chat.

        Args:
            team_id: the team, when listing team or channel members.
            channel_id: the channel; requires team_id.
            chat_id: the chat, instead of team_id/channel_id.
        """
        try:
            if (chat_id or "").strip():
                path = f"/chats/{chat_id}/members"
            elif (team_id or "").strip() and (channel_id or "").strip():
                path = f"/teams/{team_id}/channels/{channel_id}/members"
            elif (team_id or "").strip():
                path = f"/teams/{team_id}/members"
            else:
                return {"error": "Supply chat_id, or team_id, or team_id plus channel_id."}
            out = _call("GET", path, {"$top": MAX_RESULTS})
            members = [
                {"id": m.get("userId", ""), "displayName": m.get("displayName", ""), "email": m.get("email", ""), "roles": m.get("roles", [])}
                for m in (out.get("value") or [])
            ]
            return {"count": len(members), "members": members}
        except Exception as e:  # noqa: BLE001
            return _err("Teams member list", e)

    # ---- read messages ------------------------------------------------------------------

    def teams_list_channel_messages(
        team_id: str = "", channel_id: str = "", max_results: int = DEFAULT_RESULTS
    ) -> dict:
        """Read recent messages in a Teams channel.

        Args:
            team_id: the team the channel belongs to.
            channel_id: the channel.
            max_results: how many messages to return (max 50).
        """
        if not (team_id or "").strip() or not (channel_id or "").strip():
            return {"error": "team_id and channel_id are both required."}
        try:
            out = _call(
                "GET", f"/teams/{team_id}/channels/{channel_id}/messages", {"$top": _n(max_results)}
            )
            msgs = [_summarise_message(m) for m in (out.get("value") or [])]
            return {**_split_counts(msgs), "messages": msgs}
        except Exception as e:  # noqa: BLE001
            return _err(f"Channel messages for {channel_id}", e)

    def teams_list_chat_messages(chat_id: str = "", max_results: int = DEFAULT_RESULTS) -> dict:
        """Read recent messages in a 1:1 or group chat.

        Args:
            chat_id: the chat. Call teams_list_chats first.
            max_results: how many messages to return (max 50).
        """
        if not (chat_id or "").strip():
            return {"error": "chat_id is required. Call teams_list_chats first."}
        try:
            out = _call("GET", f"/chats/{chat_id}/messages", {"$top": _n(max_results)})
            msgs = [_summarise_message(m) for m in (out.get("value") or [])]
            return {**_split_counts(msgs), "chat": chat_id, "messages": msgs}
        except Exception as e:  # noqa: BLE001
            return _err(f"Chat messages for {chat_id}", e)

    def teams_get_message(
        message_id: str = "", team_id: str = "", channel_id: str = "", chat_id: str = ""
    ) -> dict:
        """Read one Teams message in full.

        Args:
            message_id: the message id.
            team_id: the team, for a channel message.
            channel_id: the channel, for a channel message.
            chat_id: the chat, for a chat message.
        """
        if not (message_id or "").strip():
            return {"error": "message_id is required."}
        try:
            if (chat_id or "").strip():
                path = f"/chats/{chat_id}/messages/{message_id}"
            elif (team_id or "").strip() and (channel_id or "").strip():
                path = f"/teams/{team_id}/channels/{channel_id}/messages/{message_id}"
            else:
                return {"error": "Supply chat_id, or both team_id and channel_id."}
            return _summarise_message(_call("GET", path))
        except Exception as e:  # noqa: BLE001
            return _err(f"Teams message read for {message_id}", e)

    def teams_list_replies(
        team_id: str = "", channel_id: str = "", message_id: str = "", max_results: int = DEFAULT_RESULTS
    ) -> dict:
        """List the replies to a channel message.

        Teams threads hang off a specific message, unlike Google Chat where threading is a
        per-space setting — so this maps exactly on the keep-Microsoft path.

        Args:
            team_id: the team.
            channel_id: the channel.
            message_id: the message whose replies are wanted.
            max_results: how many replies to return (max 50).
        """
        if not all([(team_id or "").strip(), (channel_id or "").strip(), (message_id or "").strip()]):
            return {"error": "team_id, channel_id and message_id are all required."}
        try:
            out = _call(
                "GET",
                f"/teams/{team_id}/channels/{channel_id}/messages/{message_id}/replies",
                {"$top": _n(max_results)},
            )
            msgs = [_summarise_message(m) for m in (out.get("value") or [])]
            return {"count": len(msgs), "replies": msgs}
        except Exception as e:  # noqa: BLE001
            return _err(f"Replies for message {message_id}", e)

    # ---- write --------------------------------------------------------------------------




    def teams_create_channel(team_id: str = "", name: str = "", description: str = "") -> dict:
        """Create a channel inside an existing Team.

        Args:
            team_id: the team to create the channel in.
            name: the channel's display name.
            description: optional description.
        """
        if not (team_id or "").strip() or not (name or "").strip():
            return {"error": "team_id and name are both required."}
        try:
            out = _call(
                "POST",
                f"/teams/{team_id}/channels",
                body={"displayName": name, "description": description or "", "membershipType": "standard"},
            )
            return {"created": True, "id": out.get("id", ""), "name": name, "team": team_id}
        except Exception as e:  # noqa: BLE001
            return _err(f"Channel creation in team {team_id}", e)

    # Read tools plus one create. No send/reply: app-only Graph cannot post Teams messages
    # at all (measured — see the module docstring). Do not "restore" them without re-probing.
    return [
        teams_list_joined_teams,
        teams_list_channels,
        teams_list_chats,
        teams_list_members,
        teams_list_channel_messages,
        teams_list_chat_messages,
        teams_get_message,
        teams_list_replies,
        teams_create_channel,
    ]
