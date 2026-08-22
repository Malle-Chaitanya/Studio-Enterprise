/**
 * Prove every HubSpot tool against the customer's real portal, through the SHIPPED deployer
 * path (see _lib_live_tools.ts).
 *
 * HubSpot had NO tool module until 2026-08-20 — all 33 staged agents across three connector
 * ids fell through to generic_rest.py's "call any REST API" tool, the shape the model was
 * measured declining to use. So every assertion here is on brand-new code, and three of them
 * guard facts that cost a probe each to establish (the portal-level usage endpoint does not
 * exist; the snapshot figure lags the live header; associations return bare ids).
 *
 * Read-only. Nothing here creates, updates or deletes a CRM record.
 *
 *   cd server && npx tsx src/spikes/_test_hubspot_all_tools.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { buildConnSpec, runToolAssertions, report } from './_lib_live_tools.js';

await connectMongo();
// Any of the four ids resolves to the same module and the same shared token; the CRM V2 id is
// the one the most agents (15) declare.
const { conn, project, operations } = await buildConnSpec('shared_hubspotcrmv2');
console.log(`project    : ${project}`);
console.log(`kind       : ${(conn as { kind?: string }).kind}`);
console.log(`operations : ${operations.map((o) => `${o.id}(${o.agents})`).join(', ') || '(none on this id)'}\n`);

const assertions = `
# ---- GetTheDailyApiUsageAndLimitsForAHubspotAccount (10 agents) -------------------
# The operation whose named endpoint does not exist. Five portal-level paths 404 on this
# account; usage is per private app. Asserted first because it is the one most likely to
# regress silently back to a 404 tool.
r = T["hubspot_get_api_usage"]()
check("GetTheDailyApiUsage...", r, lambda x: isinstance(x.get("dailyLimit"), int),
      note=f"limit={r.get('dailyLimit')} usedNow={r.get('usedNow')} remainingNow={r.get('remainingNow')}")
# The live header must win over the lagging snapshot. Measured 2026-08-20: snapshot said 0
# while the header said 12 used — an agent quoting the snapshot tells the user zero calls
# have been made on an account actively serving them.
if isinstance(r, dict) and not r.get("error"):
    snap = (r.get("snapshot") or {}).get("currentUsage")
    if isinstance(r.get("usedNow"), int) and r["usedNow"] > 0 and snap == 0:
        ok("live usage beats the stale snapshot", f"usedNow={r['usedNow']} vs snapshot={snap}")
    elif isinstance(r.get("usedNow"), int):
        ok("live usage reported", f"usedNow={r['usedNow']}, snapshot={snap}")
    else:
        fail("live usage reported", "no usedNow — only the snapshot, which lags")
    if "lags" in str(r.get("note", "")):
        ok("usage tool warns the snapshot lags", "")
    else:
        fail("usage tool warns the snapshot lags", "no note distinguishing live from snapshot")

# ---- account identity ------------------------------------------------------------
r = T["hubspot_get_account_info"]()
check("account info", r, lambda x: x.get("portalId"),
      note=f"portal {r.get('portalId')} ({r.get('accountType')})")

# ---- CompaniesList (8 agents) ----------------------------------------------------
r = T["hubspot_list_companies"](limit=5)
check("CompaniesList", r, lambda x: isinstance(x.get("companies"), list) and x.get("shown", 0) > 0,
      note=f"{r.get('shown')} company(ies): " + ", ".join(
          str(c.get("name")) for c in (r.get("companies") or [])[:3]))
companies = r.get("companies") or []
# A 200 with only ids and timestamps is the failure mode of every HubSpot list call made
# without an explicit properties list. The NAME must be there.
if companies and any(c.get("name") for c in companies):
    ok("companies carry real names", str(companies[0].get("name")))
else:
    fail("companies carry real names", f"first row: {json.dumps(companies[:1], default=str)[:70]}")
# ...and a record link, which is what makes an answer actionable for the user.
if companies and str(companies[0].get("url", "")).startswith("https://app.hubspot.com/"):
    ok("companies carry a record link", str(companies[0].get("url"))[:52])
else:
    fail("companies carry a record link", str(companies[:1])[:60])

# ---- contacts + deals ------------------------------------------------------------
r = T["hubspot_list_contacts"](limit=3)
check("list contacts", r, lambda x: isinstance(x.get("contacts"), list),
      note=f"{r.get('shown')} contact(s)")
r = T["hubspot_list_deals"](limit=3)
check("list deals", r, lambda x: isinstance(x.get("deals"), list),
      note=f"{r.get('shown')} deal(s)")

# ---- search: the only tool that can answer "how many" ----------------------------
if companies:
    term = str(companies[0].get("name") or "")[:12]
    r = T["hubspot_search"](object_type="companies", query=term)
    check("search companies", r, lambda x: isinstance(x.get("total"), int),
          note=f"'{term}' -> total={r.get('total')} shown={r.get('shown')}")

# ---- get one record --------------------------------------------------------------
if companies:
    cid = str(companies[0].get("id"))
    r = T["hubspot_get_record"](object_type="company", record_id=cid)
    # Singular 'company' on purpose: it is what the model will say, and the module has to
    # accept it rather than 404 on a plural/singular slip.
    check("get_record (singular type accepted)", r, lambda x: str(x.get("id")) == cid,
          note=f"{r.get('name')}")

# ---- ListAssociations (15 agents) ------------------------------------------------
# The most-used HubSpot operation. v4 returns toObjectId and NOTHING else, so the test is
# not "did it return links" but "did it return links a human can read".
assoc_tested = False
for c in companies:
    r = T["hubspot_list_associations"](from_object_type="companies", record_id=str(c.get("id")),
                                       to_object_type="contacts", limit=10)
    if isinstance(r, dict) and r.get("error"):
        fail("ListAssociations", r["error"]); assoc_tested = True; break
    rows = r.get("associations") or []
    if not rows:
        continue  # this company has no contacts linked; try the next
    assoc_tested = True
    ok("ListAssociations", f"{c.get('name')} -> {len(rows)} contact(s)")
    named = [a for a in rows if a.get("name") and not str(a["name"]).startswith("(unnamed")]
    if named:
        ok("associations are hydrated to names", ", ".join(str(a["name"]) for a in named[:3]))
    else:
        fail("associations are hydrated to names",
             f"only ids came back: {[a.get('id') for a in rows[:3]]}")
    # The association LABEL ("Billing Contact") is often the real answer to the question.
    if any(a.get("labels") for a in rows):
        ok("association labels surfaced", str([a.get("labels") for a in rows if a.get("labels")][:2]))
    else:
        ok("association labels absent on this portal",
           "no HubSpot-defined labels on these links — reported as empty, not invented")
    break
if not assoc_tested:
    fail("ListAssociations", "no company on this portal has an associated contact to test with")

# ---- an empty association must be stated, not implied ----------------------------
if companies:
    r = T["hubspot_list_associations"](from_object_type="companies",
                                       record_id=str(companies[0].get("id")),
                                       to_object_type="tickets", limit=5)
    note = str(r.get("note") or "") if isinstance(r, dict) else ""
    if isinstance(r, dict) and not r.get("error") and r.get("shown") == 0 and note:
        # ...in real English. "that companie" is what type[:-1] produced, and it reaches the
        # user verbatim.
        if "companie " in note or "companie." in note:
            fail("empty association says so, in English", note[:60])
        else:
            ok("empty association says so", note[:56])
    elif isinstance(r, dict) and r.get("error"):
        ok("empty association errors honestly", str(r["error"])[:56])
    else:
        fail("empty association says so", json.dumps(r, default=str)[:70])

# ---- negative cases --------------------------------------------------------------
print("\\n      negative cases (an honest error is a PASS):")
for label, call in [
    ("unknown object type", lambda: T["hubspot_get_record"](object_type="sharks", record_id="1")),
    ("empty record id", lambda: T["hubspot_get_record"](object_type="companies", record_id="")),
    ("bogus record id", lambda: T["hubspot_get_record"](object_type="companies", record_id="99999999999")),
    ("search with no query", lambda: T["hubspot_search"](object_type="companies", query="")),
    ("associations, bad types", lambda: T["hubspot_list_associations"](
        from_object_type="companies", record_id="1", to_object_type="sharks")),
]:
    out = call()
    honest = isinstance(out, dict) and bool(out.get("error"))
    if honest:
        ok(f"  {label}", str(out.get("error"))[:58])
    else:
        fail(f"  {label}", "no error where one was required")
`;

report(runToolAssertions(conn, project, assertions));
