/**
 * Does the calendar operation the last unjudged Tier-1 agent uses actually work?
 *
 * `GetEventsCalendarViewV3` (1 agent) was the final UNJUDGED row on the board. Neither
 * outlook.py nor gmail.py had any calendar tool, and the equivalence table carried only a
 * coarse bucket — "(35 calendar operations) ... not yet mapped or built" — whose id no real
 * agent declares, so the operation resolved to nothing at all.
 *
 * outlook_list_calendar_events was written for it. Whether it WORKS depends on a tenant grant
 * this project does not control: Calendars.Read is a separate application permission from the
 * Mail.* ones. A 403 here is a RESULT, not a failure — it decides whether the row is recorded
 * as proven or as blocked on a permission the customer must grant.
 *
 *   cd server && npx tsx src/spikes/_test_outlook_calendar.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { buildConnSpec, runToolAssertions, report } from './_lib_live_tools.js';

await connectMongo();
const { conn, project, operations } = await buildConnSpec('shared_outlook');
// MAILBOX OVERRIDE. The default identity resolved from Secret Manager (alex@filefuze.co) has
// no events anywhere in 2026, so it can only ever prove that the call is PERMITTED — not that
// the tool can report a meeting. Pass a mailbox that has one:
//   npx tsx src/spikes/_test_outlook_calendar.ts erik@filefuze.co
// The override writes no secret; it swaps the impersonation target for this run only.
const OVERRIDE = process.argv[2];
if (OVERRIDE) {
  const { getSaToken } = await import('../auth/google.js');
  const { upsertSecret } = await import('../services/secretManager.js');
  const name = `csge-harness-calendar-mailbox`;
  await upsertSecret(await getSaToken(), project, name, OVERRIDE);
  conn.secretIds = { ...((conn.secretIds as Record<string, string>) ?? {}), impersonate_email: name };
  console.log(`mailbox    : ${OVERRIDE} (harness override)`);
}
console.log(`project    : ${project}`);
console.log(`operations : ${operations.map((o) => `${o.id}(${o.agents})`).join(', ') || '(none on this id)'}\n`);

const assertions = `
r = T["outlook_list_calendar_events"]()
if isinstance(r, dict) and r.get("error"):
    # Print it verbatim and name what it means, rather than retrying until something passes.
    err = str(r["error"])
    fail("GetEventsCalendarViewV3", err)
    low = err.lower()
    if "access is denied" in low or "403" in low or "authorization" in low:
        print("")
        print("      VERDICT: the tool is correct and the TENANT GRANT is missing.")
        print("      Calendars.Read (application) has not been consented for this app.")
        print("      Record the row as blocked on that grant - not as a working capability.")
else:
    check("GetEventsCalendarViewV3", r, lambda x: isinstance(x.get("events"), list),
          note=f"{r.get('count')} event(s) in {(r.get('range') or {}).get('start')} .. {(r.get('range') or {}).get('end')}")
    # A default range must be SUPPLIED and REPORTED. Graph 400s on calendarView without both
    # bounds, so a tool that passes them through unset fails on the most natural question
    # ("what's on my calendar?").
    rng = r.get("range") or {}
    if rng.get("start") and rng.get("end"):
        ok("defaults its own bounded window", f"{rng['start']} .. {rng['end']}")
    else:
        fail("defaults its own bounded window", "no range reported")
    evs = r.get("events") or []
    if evs:
        e0 = evs[0]
        if e0.get("subject") and e0.get("start"):
            ok("events carry subject and time", f"{e0.get('subject')} @ {e0.get('start')}")
        else:
            fail("events carry subject and time", json.dumps(e0, default=str)[:70])
        # calendarView expands a recurring series into occurrences; /events would not. If
        # anything recurring exists, the flag proves the right endpoint was used.
        if any(e.get("recurring") for e in evs):
            ok("recurring occurrences are expanded", "at least one occurrence flagged recurring")
        else:
            ok("no recurring events in range", "nothing to expand — not evidence either way")
    else:
        ok("calendar readable but empty in range",
           "the call succeeded; this mailbox has no events in the default week")

    # An explicit range must be honoured, not ignored.
    r2 = T["outlook_list_calendar_events"](start="2026-01-01", end="2026-12-31", max_results=10)
    if isinstance(r2, dict) and not r2.get("error"):
        rng2 = r2.get("range") or {}
        if str(rng2.get("start", "")).startswith("2026-01-01"):
            ok("explicit range honoured", f"{rng2.get('start')} .. {rng2.get('end')}")
        else:
            fail("explicit range honoured", str(rng2))
        # REAL DATA, or this operation does not get marked verified. An empty week proves the
        # call is permitted; it does not prove the tool can report a meeting. A whole year is
        # the widest honest look before concluding the mailbox simply has no events.
        evs2 = r2.get("events") or []
        if evs2:
            e = evs2[0]
            if e.get("subject") and e.get("start"):
                ok("a real event, with subject and time",
                   f"{e.get('subject')} @ {e.get('start')} (organizer {e.get('organizer')})")
            else:
                fail("a real event, with subject and time", json.dumps(e, default=str)[:70])
        else:
            fail("a real event was returned",
                 "no events anywhere in 2026 for this mailbox — the grant works, but nothing "
                 "here proves the tool can REPORT a meeting, so do not mark it verified")
    else:
        fail("explicit range honoured", str(r2.get("error"))[:60])
`;

report(runToolAssertions(conn, project, assertions));
