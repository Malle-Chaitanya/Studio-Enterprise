/**
 * Prove the Microsoft Teams tools on the KEEP-TEAMS path, through the SHIPPED deployer path.
 *
 * Three operations remained unproven on the board:
 *   GetTeam                11 agents  — judged `lost` for Teams->Chat, works unchanged here
 *   GetAllChannelsForTeam   6 agents  — no verdict in any table
 *   GetChats                6 agents  — no verdict in any table
 *
 * The distinction the equivalence table draws matters here: `fidelity: 'lost'` on a Teams row
 * is a statement about the CROSS-VENDOR move to Google Chat (which has no team object), not
 * about the customer who chooses to stay on Microsoft. For that customer these operations are
 * served by Graph, and this harness is what turns "Graph should serve it" into evidence.
 *
 * Read-only: teams_create_channel is deliberately NOT exercised.
 *
 *   cd server && npx tsx src/spikes/_test_teams_all_tools.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { buildConnSpec, runToolAssertions, report } from './_lib_live_tools.js';

await connectMongo();
const { conn, project, operations } = await buildConnSpec('shared_teams');
console.log(`project    : ${project}`);
console.log(`authKind   : ${(conn as { authKind?: string }).authKind}`);
console.log(`operations : ${operations.map((o) => `${o.id}(${o.agents})`).join(', ')}\n`);

const assertions = `
# ---- GetTeam / ListJoinedTeams (11 agents) ---------------------------------------
# Graph has no "get the team" for an app-only caller without a user context, so the tool
# lists the teams the configured user has joined. Asserted as a real list with real ids,
# because an empty list here would make every channel assertion below vacuous.
r = T["teams_list_joined_teams"](max_results=10)
check("GetTeam -> list_joined_teams", r,
      lambda x: isinstance(x.get("teams"), list),
      note=f"{len(r.get('teams') or [])} team(s): " + ", ".join(
          str(t.get("name")) for t in (r.get("teams") or [])[:3]))
teams = r.get("teams") or []
if teams and teams[0].get("id"):
    ok("teams carry ids channels can be listed by", str(teams[0].get("id"))[:40])
    # A team the agent cannot NAME is useless for answering "which teams am I in?".
    if all(str(t.get("name") or "").strip() for t in teams):
        ok("teams carry names", ", ".join(str(t.get("name")) for t in teams[:3]))
    else:
        fail("teams carry names", f"blank name in {json.dumps(teams[:2], default=str)[:70]}")
elif not teams:
    fail("teams carry ids channels can be listed by",
         "no team returned — either the configured user has joined none, or the app "
         "permission Team.ReadBasic.All is missing")

# ---- GetAllChannelsForTeam (6 agents) -------------------------------------------
if teams:
    tid = str(teams[0].get("id"))
    r = T["teams_list_channels"](team_id=tid, max_results=20)
    check("GetAllChannelsForTeam", r, lambda x: isinstance(x.get("channels"), list),
          note=f"{len(r.get('channels') or [])} channel(s): " + ", ".join(
              str(c.get("name")) for c in (r.get("channels") or [])[:4]))
    chans = r.get("channels") or []
    # Every team has a General channel. Its absence means the call succeeded against
    # something other than the team we asked about.
    if any(str(c.get("name")) == "General" for c in chans):
        ok("channel list is really this team's", "General present")
    elif chans:
        ok("channel list returned", f"no General, but {len(chans)} channel(s) — unusual, not wrong")
    else:
        fail("channel list is really this team's", "no channels at all for a joined team")
else:
    fail("GetAllChannelsForTeam", "skipped: no team to list channels for")

# ---- GetChats (6 agents) ---------------------------------------------------------
# Chats belong to a PERSON, so this one depends on impersonate_email being configured.
# A tool that silently returns nothing because no user was named is the failure mode.
r = T["teams_list_chats"](max_results=10)
if isinstance(r, dict) and r.get("error"):
    fail("GetChats", r["error"])
else:
    chats = r.get("chats") or []
    check("GetChats", r, lambda x: isinstance(x.get("chats"), list), note=f"{len(chats)} chat(s)")
    if chats:
        # A 1:1 chat legitimately has no topic, so the tool must still say WHO it is with —
        # otherwise a list of ten chats is ten opaque rows.
        # The name field, and it must not be a PLACEHOLDER. "(no topic)" was the old value for every
        # 1:1 chat and it satisfies a naive truthiness check while telling the user nothing —
        # so the placeholder is named here explicitly.
        named = [c for c in chats
                 if str(c.get("name") or "").strip()
                 and str(c.get("name")) not in ("(no topic)", "(unnamed chat)")]
        if len(named) >= max(1, len(chats) // 2):
            ok("chats are identifiable, not placeholders",
               "; ".join(str(c.get("name")) for c in named[:3])[:60])
        else:
            fail("chats are identifiable, not placeholders",
                 f"{len(named)}/{len(chats)} have a real name: "
                 f"{[c.get('name') for c in chats[:4]]}")
    else:
        # Distinguish "this user has no chats" from "no user was configured" — they look
        # identical in the result and are completely different problems.
        fail("GetChats returned an empty list",
             "either the configured user has no chats, or impersonate_email is unset and the "
             "tool had no user to read for — the tool must not be silent about which")

# ---- negative cases --------------------------------------------------------------
print("\\n      negative cases (an honest error is a PASS):")
for label, call in [
    ("channels for a bogus team", lambda: T["teams_list_channels"](team_id="not-a-real-team-id")),
    ("members with no target", lambda: T["teams_list_members"]()),
]:
    out = call()
    honest = isinstance(out, dict) and bool(out.get("error"))
    if honest:
        ok(f"  {label}", str(out.get("error"))[:58])
    else:
        fail(f"  {label}", f"no error where one was required: {json.dumps(out, default=str)[:60]}")
`;

report(runToolAssertions(conn, project, assertions));
