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

ADDITIONAL PERMISSIONS — for the read/write tools added below (2026-08-24). Cross-checked
against Microsoft Graph's own reference docs and the swagger capture in
connectors/fixtures/shared_teams.ops.json.

The three READ operations below are MEASURED, not inferred, same as the block above
(_diag_teams_new_reads_probe.ts, 2026-08-24, tenant 807d6772, app ConnectorsTest): all three
returned real data on the first try.

    READ  a team by id            Team.ReadBasic.All (already requested above) — PASS,
                                   returned "22nov_public-channel", visibility=public
    READ  a channel by id         Channel.ReadBasic.All (already requested above) — PASS,
                                   returned "General", membershipType=standard
    READ  associated teams        Team.ReadBasic.All (already requested above) — PASS, 22
                                   associated teams returned for erik@filefuze.co. Graph
                                   rejects the `/me` alias app-only, so this calls
                                   `/users/{id}/teamwork/associatedTeams`, not the path the
                                   Copilot swagger uses — the corrected path is what was tested.

The four WRITE operations below are NOT yet measured — each would create or mutate real
state in the tenant (a renamed/archived channel, a new chat, a whole new Microsoft 365
group), so probing them was deliberately deferred rather than done as a side effect of
writing this docstring. Probe deliberately, not incidentally, before this report calls them
verified:

    WRITE update channel          Channel.ReadWrite.All — same "grantable, 403 until granted"
    WRITE archive channel         Channel.ReadWrite.All    shape as teams_create_channel's
                                                            Channel.Create, below
    WRITE create a team           Team.Create — provisions a whole Microsoft 365 group, not
                                   a channel inside one; heavier than create-channel and
                                   requires >=1 owner in the request body
    WRITE create a chat           Chat.Create — creates the chat object only. It does NOT
                                   unblock sending a message into it: that is still the same
                                   Teamwork.Migrate.All wall documented above.

Two more operations from the same swagger stay UNBUILT, because Microsoft has no app-only
route for either:

    Post a message to myself      the identical chatMessage-POST wall as every other Teams
                                   message — "myself" changes who reads it, not which
                                   permission exists.
    Post a feed notification      the swagger's PostFeedNotification/PostUserNotification is
                                   the legacy Power Automate flow-bot proxy this file does not
                                   talk to (it calls graph.microsoft.com directly). Graph's own
                                   activity-feed API (POST /users/{id}/teamwork/
                                   sendActivityNotification) exists, but requires the activity
                                   type to be declared in a REGISTERED Teams app manifest —
                                   infrastructure this product has not set up. Do not add a
                                   tool for either without a new mechanism, not just a permission.
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

    def teams_get_team(team_id: str = "") -> dict:
        """Get one Team's details by id.

        Args:
            team_id: the team's id. Call teams_list_joined_teams first.
        """
        if not (team_id or "").strip():
            return {"error": "team_id is required. Call teams_list_joined_teams first."}
        try:
            t = _call("GET", f"/teams/{team_id}")
            return {
                "id": t.get("id", ""),
                "name": t.get("displayName", ""),
                "description": t.get("description", ""),
                "visibility": t.get("visibility", ""),
            }
        except Exception as e:  # noqa: BLE001
            return _err(f"Team read for {team_id}", e)

    def teams_get_channel(team_id: str = "", channel_id: str = "") -> dict:
        """Get one channel's details by id.

        Args:
            team_id: the team the channel belongs to.
            channel_id: the channel.
        """
        if not (team_id or "").strip() or not (channel_id or "").strip():
            return {"error": "team_id and channel_id are both required."}
        try:
            c = _call("GET", f"/teams/{team_id}/channels/{channel_id}")
            return {
                "id": c.get("id", ""),
                "name": c.get("displayName", ""),
                "description": c.get("description", ""),
                "membershipType": c.get("membershipType", ""),
            }
        except Exception as e:  # noqa: BLE001
            return _err(f"Channel read for {channel_id}", e)

    def teams_list_associated_teams(max_results: int = DEFAULT_RESULTS) -> dict:
        """List Teams associated with a shared channel this agent's user belongs to.

        Args:
            max_results: how many teams to return (max 50).
        """
        user = _user()
        if not user:
            return {"error": "No user is configured for this agent."}
        try:
            # The Copilot swagger calls /me/teamwork/associatedTeams — Graph rejects the /me
            # alias app-only, so this calls the /users/{id} equivalent instead (measured
            # against Graph's own permissions reference, not yet against a live tenant).
            out = _call("GET", f"/users/{urllib.parse.quote(user)}/teamwork/associatedTeams")
            teams = [
                {"id": t.get("id", ""), "name": t.get("displayName", ""), "tenantId": t.get("tenantId", "")}
                for t in (out.get("value") or [])
            ][: _n(max_results)]
            return {"count": len(teams), "teams": teams, "actingAs": user}
        except Exception as e:  # noqa: BLE001
            return _err(f"Associated teams for {user}", e)

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

    def teams_update_channel(team_id: str = "", channel_id: str = "", name: str = "", description: str = "") -> dict:
        """Rename or re-describe a channel.

        Args:
            team_id: the team the channel belongs to.
            channel_id: the channel to update.
            name: new display name. Leave blank to keep the current one.
            description: new description. Leave blank to keep the current one.
        """
        if not (team_id or "").strip() or not (channel_id or "").strip():
            return {"error": "team_id and channel_id are both required."}
        body = {}
        if (name or "").strip():
            body["displayName"] = name
        if (description or "").strip():
            body["description"] = description
        if not body:
            return {"error": "Supply a new name or description — nothing to update."}
        try:
            _call("PATCH", f"/teams/{team_id}/channels/{channel_id}", body=body)
            return {"updated": True, "team": team_id, "channel": channel_id, **body}
        except Exception as e:  # noqa: BLE001
            return _err(f"Channel update for {channel_id}", e)

    def teams_archive_channel(team_id: str = "", channel_id: str = "") -> dict:
        """Archive a channel. Members can still see it but cannot post. Unarchiving is not
        exposed by this tool — it has to be done from the Teams client.

        Args:
            team_id: the team the channel belongs to.
            channel_id: the channel to archive.
        """
        if not (team_id or "").strip() or not (channel_id or "").strip():
            return {"error": "team_id and channel_id are both required."}
        try:
            # Graph runs this asynchronously (202, empty body) — there is no id to hand back,
            # only the fact that the request was accepted.
            _call("POST", f"/teams/{team_id}/channels/{channel_id}/archive", body={})
            return {"archiveRequested": True, "team": team_id, "channel": channel_id}
        except Exception as e:  # noqa: BLE001
            return _err(f"Channel archive for {channel_id}", e)

    def teams_create_chat(member_emails: str = "", topic: str = "") -> dict:
        """Start a new 1:1 or group chat with one or more people.

        This creates the chat object only — it does not send a first message. Sending into a
        Teams chat has no app-only Graph route (see the module docstring): the chat is
        created empty, and someone has to send the first message from the Teams client.

        Args:
            member_emails: comma-separated email addresses of the other participant(s). One
                person makes a 1:1 chat; more than one makes a group chat.
            topic: group chat name. Ignored for a 1:1 chat — Teams does not support naming those.
        """
        user = _user()
        if not user:
            return {"error": "No user is configured for this agent."}
        emails = [e.strip() for e in (member_emails or "").split(",") if e.strip()]
        if not emails:
            return {"error": "member_emails must name at least one other person."}
        is_group = len(emails) > 1 or bool((topic or "").strip())

        def _member(email):
            return {
                "@odata.type": "#microsoft.graph.aadUserConversationMember",
                "roles": ["owner"] if is_group else [],
                "user@odata.bind": f"https://graph.microsoft.com/v1.0/users('{urllib.parse.quote(email)}')",
            }

        body = {
            "chatType": "group" if is_group else "oneOnOne",
            "members": [_member(user)] + [_member(e) for e in emails],
        }
        if is_group and (topic or "").strip():
            body["topic"] = topic
        try:
            out = _call("POST", "/chats", body=body)
            return {"created": True, "id": out.get("id", ""), "chatType": body["chatType"], "with": emails}
        except Exception as e:  # noqa: BLE001
            return _err("Chat creation", e)

    def teams_create_team(display_name: str = "", description: str = "", owner_email: str = "") -> dict:
        """Create a new Team. Heavier than teams_create_channel: this provisions a whole new
        Microsoft 365 group, not a channel inside an existing one.

        Args:
            display_name: the Team's name.
            description: optional description.
            owner_email: the Team's owner. Defaults to this agent's configured user.
        """
        if not (display_name or "").strip():
            return {"error": "display_name is required."}
        owner = (owner_email or "").strip() or _user()
        if not owner:
            return {"error": "owner_email is required — no user is configured for this agent."}
        body = {
            "template@odata.bind": "https://graph.microsoft.com/v1.0/teamsTemplates('standard')",
            "displayName": display_name,
            "description": description or "",
            "members": [{
                "@odata.type": "#microsoft.graph.aadUserConversationMember",
                "roles": ["owner"],
                "user@odata.bind": f"https://graph.microsoft.com/v1.0/users('{urllib.parse.quote(owner)}')",
            }],
        }
        try:
            # Team creation is asynchronous: Graph returns 202 with no body, and the real
            # result lands on a teamsAsyncOperation the caller would have to poll separately.
            # Reporting "requested", not "created", is the same honesty rule as everywhere
            # else in this file — claiming success we have not observed is the thing refused.
            _call("POST", "/teams", body=body)
            return {"creationRequested": True, "name": display_name, "owner": owner}
        except Exception as e:  # noqa: BLE001
            return _err(f"Team creation for {display_name}", e)

    # Read tools, then writes. No send/reply/post-to-self/feed-notification: app-only Graph
    # cannot post Teams messages at all, by any route (measured — see the module docstring).
    # Do not "restore" them without re-probing.
    return [
        teams_list_joined_teams,
        teams_get_team,
        teams_list_channels,
        teams_get_channel,
        teams_list_associated_teams,
        teams_list_chats,
        teams_list_members,
        teams_list_channel_messages,
        teams_list_chat_messages,
        teams_get_message,
        teams_list_replies,
        teams_create_channel,
        teams_update_channel,
        teams_archive_channel,
        teams_create_chat,
        teams_create_team,
    ]
