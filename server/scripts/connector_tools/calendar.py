"""Google Calendar live tools — the Google-side equivalent of Copilot's Office 365
Outlook Calendar operations (Create event, Get calendar view of events, Get
calendars, Find meeting times).

Confirmed against Google's own official API reference (2026-08-31, not just this
codebase's own assumptions): `events.insert` ("Creates an event"), `events.list`
("Returns events on the specified calendar"), and `freebusy.query` (checks
free/busy across calendars without needing full event details) all exist,
are documented, and require nothing beyond a standard OAuth scope — no prior
calendar data, no platform blocker. There was previously NO calendar tool in
this codebase at all (see connectors/equivalence.ts OTHER_SURFACES: "NOT BUILT
on the Google path"); this module is what closes that gap, mirroring the same
DWD-impersonation shape gmail.py already proved live.

Like gmail.py, this is CROSS-VENDOR: a Copilot agent that read/wrote Outlook
Calendar migrates to one that reads/writes Google Calendar. The intent
survives; the shapes differ in places, documented per tool below:

  * Outlook's "Show As" (Free/Busy/Tentative/OOF) maps to Google's `transparency`
    (`opaque` = busy, `transparent` = free) plus `status` (`tentative` when
    unsure) — a 4-state field collapses to roughly 2-3 states.
  * Outlook events live on ONE calendar the connector targets explicitly.
    Google Calendar's `primary` alias always means the impersonated account's
    own default calendar — this module never guesses a different one, exactly
    the ambiguity a real migration test this session traced back to a
    Copilot-side connection mismatch (an agent's Create-event action silently
    bound to a different person's connection than its other actions). Here
    there is only ONE identity per deployed agent (`impersonate_email`), so
    that whole class of bug cannot recur on this side.

IDENTITY: same pattern as gmail.py — Domain-Wide Delegation with a single
impersonated subject. Every response carries `calendar` (whose calendar this
is), so an answer can never silently look like it is about someone else's
schedule.

AUTH: requires the `https://www.googleapis.com/auth/calendar` scope (read +
write) via DWD, granted separately from any Gmail scope — same relationship
Calendars.Read has to Mail.* on the Microsoft side (connector_tools/outlook.py
already documents that grants are per-capability, not bundled).

See connector_tools/gmail.py for the shared build_tools contract and the
reasoning behind nesting every helper inside build_tools (cloudpickle needs
them pickled BY VALUE, not by module-level reference).
"""

API = "https://www.googleapis.com/calendar/v3"

# Same reasoning as gmail.py's MAX_RESULTS: a wall of events buries the answer
# and burns the context window for no benefit to the model or the user.
MAX_RESULTS = 25
DEFAULT_RESULTS = 10


def build_tools(conn, secret, mint_token, auth_header, fill):
    def _mailbox() -> str:
        """Whose calendar these tools actually read/write. Reported on every response."""
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
        line — see connector_tools/outlook.py's `_err` for the same pattern. A bare
        'HTTP Error 403' tells the customer nothing useful."""
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:400]
        except Exception:  # noqa: BLE001
            detail = str(e)
        return {"error": f"{what}: {detail}"}

    def calendar_get_current_datetime() -> dict:
        """Get the REAL current date, time and day of week for this account. ALWAYS call
        this before answering anything that references "today", "tomorrow", "this week",
        "next Monday" or any other relative date, and before creating, updating,
        responding to, or checking availability for any event based on a relative date.

        You have NO other way to know the actual current date — a model's training data
        has a fixed cutoff and is never "now". Guessing produced a real, live-observed
        failure: asked "when is my free time today", a deployed agent answered "you are
        free all day today, May 15, 2024" — a hallucinated date carried into everything
        that followed, including a real booking confirmation.

        Returns:
            dict with `mailbox`, `date` (YYYY-MM-DD), `time` (HH:MM:SS), `dayOfWeek`,
            `timezone` (this account's OWN calendar timezone, not the server's), `iso`
            (full RFC3339 — the value to use as start_time/end_time when the caller means
            "now"), or `error`.
        """
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        # The account's OWN calendar timezone, not wherever the container happens to run
        # (Reasoning Engines run in UTC) — "today" means today IN THE USER'S OWN TIMEZONE,
        # which can already be tomorrow or still yesterday relative to UTC.
        tz_name = "UTC"
        try:
            cal = _get("/calendars/primary", {}, token)
            tz_name = cal.get("timeZone") or "UTC"
        except Exception:  # noqa: BLE001 — the timezone lookup is a nicety, never fatal
            pass
        import datetime as _dt

        try:
            from zoneinfo import ZoneInfo

            now = _dt.datetime.now(ZoneInfo(tz_name))
        except Exception:  # noqa: BLE001 — an unrecognised tz name must not break "what is today"
            now = _dt.datetime.now(_dt.timezone.utc)
            tz_name = "UTC"
        return {
            "mailbox": _mailbox(),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M:%S"),
            "dayOfWeek": now.strftime("%A"),
            "timezone": tz_name,
            "iso": now.isoformat(),
        }

    def calendar_list_calendars() -> dict:
        """List the calendars this connection can see — Google's equivalent of Outlook's
        "Get calendars". Useful for confirming which calendar `primary` refers to, or
        finding a shared/secondary calendar the user asked about by name.

        Returns:
            dict with `mailbox` (whose account this is), `calendars` (id, summary,
            primary, accessRole), `count`, or `error`.
        """
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            data = _get("/users/me/calendarList", {}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Calendar list failed: {e}"}
        calendars = [
            {
                "id": c.get("id"),
                "summary": c.get("summary"),
                "primary": bool(c.get("primary")),
                "accessRole": c.get("accessRole"),
            }
            for c in data.get("items", []) or []
        ]
        return {"mailbox": _mailbox(), "calendars": calendars, "count": len(calendars)}

    def calendar_list_events(start_time: str, end_time: str, max_results: int = DEFAULT_RESULTS) -> dict:
        """List events on the primary calendar within a date/time range — the equivalent of
        Outlook's "Get calendar view of events". Use this to answer "am I free", "what do I
        have today", or "what's on my calendar this week".

        Args:
            start_time: range start, RFC3339 (e.g. "2026-08-31T00:00:00Z"). Required —
                Google's events.list without a range can return the wrong slice of a
                recurring series; always scope the query explicitly.
            end_time: range end, RFC3339.
            max_results: how many events to return, 1-25. Defaults to 10.

        Returns:
            dict with `mailbox`, `events` (id, summary, start, end, status, transparency,
            attendees), `count`, `truncated`, or `error`.
        """
        if not start_time or not end_time:
            return {"error": "start_time and end_time are both required (RFC3339)"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            want = max(1, min(int(max_results or DEFAULT_RESULTS), MAX_RESULTS))
        except (TypeError, ValueError):
            want = DEFAULT_RESULTS
        params = {
            "timeMin": start_time,
            "timeMax": end_time,
            "maxResults": str(want),
            "singleEvents": "true",  # expands recurring series into real occurrences —
            # the same reason outlook.py's proven tool uses calendarView instead of plain
            # /events: without this, a weekly meeting returns its series master ONCE and
            # undercounts every occurrence, which is exactly the bug that tool was built to
            # avoid on the Microsoft side.
            "orderBy": "startTime",
        }
        try:
            data = _get("/calendars/primary/events", params, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Calendar events list failed: {e}"}
        events = []
        for e in data.get("items", []) or []:
            start = e.get("start", {}) or {}
            end = e.get("end", {}) or {}
            events.append({
                "id": e.get("id"),
                "summary": e.get("summary", "(no title)"),
                "start": start.get("dateTime") or start.get("date"),
                "end": end.get("dateTime") or end.get("date"),
                "status": e.get("status"),
                # opaque = busy, transparent = free — see module docstring. Reported
                # explicitly so the model does not treat every listed event as blocking.
                "transparency": e.get("transparency", "opaque"),
                "attendees": [a.get("email") for a in e.get("attendees", []) or [] if a.get("email")],
            })
        return {
            "mailbox": _mailbox(),
            "events": events,
            "count": len(events),
            "truncated": bool(data.get("nextPageToken")),
        }

    def calendar_check_availability(start_time: str, end_time: str, attendee_emails: str = "") -> dict:
        """Check free/busy status for the account (and optionally other attendees) over a
        time range — the equivalent of Outlook's "Find meeting times". Use this BEFORE
        booking, to confirm a slot actually works for everyone, not just the organizer.

        Args:
            start_time: range start, RFC3339.
            end_time: range end, RFC3339.
            attendee_emails: comma-separated emails to check alongside the account's own
                calendar. Each must be a real, resolvable calendar (a Workspace user, or a
                calendar explicitly shared with this account) — an email with no visible
                calendar comes back with an empty busy list, which is NOT the same as
                confirmed-free and must be reported as unknown, not as available.

        Returns:
            dict with `mailbox`, `busy` (per-calendar list of busy time ranges),
            `unresolvable` (emails Google could not find calendar data for), or `error`.
        """
        if not start_time or not end_time:
            return {"error": "start_time and end_time are both required (RFC3339)"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        emails = [e.strip() for e in (attendee_emails or "").split(",") if e.strip()]
        items = [{"id": "primary"}] + [{"id": e} for e in emails]
        try:
            data = _write("/freeBusy", {"timeMin": start_time, "timeMax": end_time, "items": items}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Calendar free/busy check failed: {e}"}
        calendars = data.get("calendars", {}) or {}
        busy = {}
        unresolvable = []
        for cal_id, info in calendars.items():
            if info.get("errors"):
                unresolvable.append(cal_id)
                continue
            busy[cal_id] = [
                {"start": b.get("start"), "end": b.get("end")} for b in info.get("busy", []) or []
            ]
        result = {"mailbox": _mailbox(), "busy": busy}
        if unresolvable:
            result["unresolvable"] = unresolvable
            result["note"] = (
                f"Could not read calendar data for: {', '.join(unresolvable)}. Their "
                "availability is UNKNOWN, not confirmed free — say so rather than assuming."
            )
        return result

    def calendar_create_event(
        subject: str,
        start_time: str,
        end_time: str,
        time_zone: str = "UTC",
        attendees: str = "",
        description: str = "",
        busy: bool = True,
    ) -> dict:
        """Create (book) a calendar event on the account's primary calendar. This is
        equivalent to Outlook's "Create event" and sends real invites to any attendees.

        ALWAYS confirm the title, time, and attendee list with the user before calling
        this — booking is a real action a real person will see on their calendar and, for
        attendees, receive an invite for.

        Args:
            subject: the event title.
            start_time: RFC3339 datetime, e.g. "2026-09-01T14:00:00". Interpreted in
                `time_zone`, NOT necessarily UTC — pass plain local clock time matching
                `time_zone`, do not pre-convert it yourself.
            end_time: RFC3339 datetime, same rule as start_time.
            time_zone: IANA timezone name, e.g. "Asia/Kolkata" or "America/New_York".
                Required for the start/end values to land at the intended time — omitting
                or guessing this is the single most common cause of an event appearing at
                the wrong hour.
            attendees: comma-separated email addresses to invite. Each gets a real
                calendar invite in their own mailbox.
            description: optional event body/agenda text.
            busy: whether this event should block the organizer's time (True, the
                default) or show as free (False). Defaults to True because a booked
                meeting that does not block future availability checks is a real,
                previously-observed fidelity gap, not a safe default.

        Returns:
            dict with `created` true, `id`, `htmlLink`, `summary`, `start`, `end`,
            `attendees`, or `error`.
        """
        if not subject or not start_time or not end_time:
            return {"error": "subject, start_time, and end_time are all required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        attendee_list = [{"email": a.strip()} for a in (attendees or "").split(",") if a.strip()]
        body = {
            "summary": subject,
            "description": description or "",
            "start": {"dateTime": start_time, "timeZone": time_zone or "UTC"},
            "end": {"dateTime": end_time, "timeZone": time_zone or "UTC"},
            "attendees": attendee_list,
            # opaque = busy, transparent = free. Set explicitly rather than left to
            # Google's own default, for the same reason `busy` defaults True above.
            "transparency": "opaque" if busy else "transparent",
        }
        try:
            # sendUpdates=all is what actually triggers real invite emails to attendees —
            # without it Google creates the event silently and nobody but the organizer
            # ever sees it, which would reproduce the exact "booked but nobody was told"
            # gap this session traced on the Outlook side back to a connection mismatch.
            created = _write("/calendars/primary/events?sendUpdates=all", body, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Calendar event creation failed: {e}"}
        return {
            "created": True,
            "mailbox": _mailbox(),
            "id": created.get("id"),
            "htmlLink": created.get("htmlLink"),
            "summary": created.get("summary"),
            "start": (created.get("start") or {}).get("dateTime"),
            "end": (created.get("end") or {}).get("dateTime"),
            "attendees": [a.get("email") for a in created.get("attendees", []) or [] if a.get("email")],
        }

    def calendar_get_event(event_id: str) -> dict:
        """Get a single event by id — the equivalent of Outlook's "Get event". Use this to
        read full details (attendees, description, status) for an event already surfaced
        by calendar_list_events.

        Args:
            event_id: the event id from calendar_list_events or calendar_create_event.

        Returns:
            dict with `mailbox`, `id`, `summary`, `start`, `end`, `status`, `transparency`,
            `description`, `attendees`, or `error`.
        """
        if not event_id:
            return {"error": "event_id is required"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            e = _get(f"/calendars/primary/events/{event_id}", {}, token)
        except Exception as exc:  # noqa: BLE001
            return {"error": f"Calendar event lookup failed: {exc}"}
        start = e.get("start", {}) or {}
        end = e.get("end", {}) or {}
        return {
            "mailbox": _mailbox(),
            "id": e.get("id"),
            "summary": e.get("summary", "(no title)"),
            "start": start.get("dateTime") or start.get("date"),
            "end": end.get("dateTime") or end.get("date"),
            "status": e.get("status"),
            "transparency": e.get("transparency", "opaque"),
            "description": e.get("description", ""),
            "attendees": [a.get("email") for a in e.get("attendees", []) or [] if a.get("email")],
        }

    def calendar_update_event(
        event_id: str,
        subject: str = "",
        start_time: str = "",
        end_time: str = "",
        time_zone: str = "UTC",
        description: str = "",
    ) -> dict:
        """Update an existing event — the equivalent of Outlook's "Update event". Only the
        fields you pass are changed; leave the rest blank to keep them as-is.

        Args:
            event_id: the event id to update.
            subject: new title, or blank to leave unchanged.
            start_time: new RFC3339 start, or blank to leave unchanged. If set, end_time
                must be set too — Google requires both ends of the range together.
            end_time: new RFC3339 end, or blank to leave unchanged.
            time_zone: IANA timezone for start_time/end_time, e.g. "Asia/Kolkata".
            description: new body/agenda text, or blank to leave unchanged.

        Returns:
            dict with `updated` true, `id`, `summary`, `start`, `end`, or `error`.
        """
        if not event_id:
            return {"error": "event_id is required"}
        if (start_time and not end_time) or (end_time and not start_time):
            return {"error": "start_time and end_time must both be given together, or both left blank"}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        body: dict = {}
        if subject:
            body["summary"] = subject
        if description:
            body["description"] = description
        if start_time and end_time:
            body["start"] = {"dateTime": start_time, "timeZone": time_zone or "UTC"}
            body["end"] = {"dateTime": end_time, "timeZone": time_zone or "UTC"}
        if not body:
            return {"error": "nothing to update — pass at least one field"}
        try:
            # sendUpdates=all so attendees see the change, matching Outlook's own
            # notify-on-update behaviour and calendar_create_event's own choice above.
            updated = _write(f"/calendars/primary/events/{event_id}?sendUpdates=all", body, token, method="PATCH")
        except Exception as e:  # noqa: BLE001
            return {"error": f"Calendar event update failed: {e}"}
        return {
            "updated": True,
            "mailbox": _mailbox(),
            "id": updated.get("id"),
            "summary": updated.get("summary"),
            "start": (updated.get("start") or {}).get("dateTime"),
            "end": (updated.get("end") or {}).get("dateTime"),
        }

    def calendar_respond_to_event(event_id: str, response: str, comment: str = "") -> dict:
        """Respond to a meeting invite — the equivalent of Outlook's "Respond to an event
        invite". Sets the impersonated account's OWN response on an event it was invited
        to; it cannot respond on behalf of anyone else.

        Args:
            event_id: the event id to respond to.
            response: one of "accepted", "declined", "tentative".
            comment: optional note sent back to the organizer.

        Returns:
            dict with `responded` true, `id`, `response`, or `error`.
        """
        if not event_id:
            return {"error": "event_id is required"}
        norm = (response or "").strip().lower()
        if norm not in ("accepted", "declined", "tentative"):
            return {"error": 'response must be one of "accepted", "declined", "tentative"'}
        try:
            token = mint_token(fill)
        except Exception as e:  # noqa: BLE001
            return {"error": f"auth failed: {e}"}
        try:
            event = _get(f"/calendars/primary/events/{event_id}", {}, token)
        except Exception as e:  # noqa: BLE001
            return {"error": f"Calendar event lookup failed: {e}"}
        attendees = event.get("attendees", []) or []
        me = _mailbox().lower()
        found = False
        for a in attendees:
            if (a.get("email") or "").lower() == me or a.get("self"):
                a["responseStatus"] = norm
                if comment:
                    a["comment"] = comment
                found = True
        if not found:
            # Google Calendar has no concept of "respond" for someone not already listed
            # as an attendee — unlike the Outlook op, which lets the connector target any
            # event_id regardless of invite state. Reported rather than silently no-op'd.
            return {"error": f"{_mailbox()} is not an attendee on this event — nothing to respond to"}
        try:
            updated = _write(
                f"/calendars/primary/events/{event_id}?sendUpdates=all",
                {"attendees": attendees},
                token,
                method="PATCH",
            )
        except Exception as e:  # noqa: BLE001
            return {"error": f"Calendar event response failed: {e}"}
        return {"responded": True, "mailbox": _mailbox(), "id": updated.get("id"), "response": norm}

    # calendar_get_current_datetime FIRST, ahead of even the other read tools — it is the
    # one every relative-date question depends on, and the model reaches for what it sees
    # earliest. See adkDeployer.ts's globalInstruction rule, which additionally makes
    # calling it non-negotiable rather than relying on tool order alone.
    return [
        calendar_get_current_datetime,
        calendar_list_calendars,
        calendar_list_events,
        calendar_check_availability,
        calendar_create_event,
        calendar_get_event,
        calendar_update_event,
        calendar_respond_to_event,
    ]
