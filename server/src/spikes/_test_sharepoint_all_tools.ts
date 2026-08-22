/**
 * Prove the SharePoint tools against the customer's real site, through the SHIPPED deployer
 * path (see _lib_live_tools.ts).
 *
 * `GetAllTables` (2 agents) was the last Tier-1 row carrying a tool that had never been run:
 * the equivalence table named sharepoint_list_lists and marked it unverified, which is the
 * honest state but not a finished one. This turns it into evidence or into a defect.
 *
 * Read-only — SharePoint has no write tools, deliberately.
 *
 *   cd server && npx tsx src/spikes/_test_sharepoint_all_tools.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { buildConnSpec, runToolAssertions, report } from './_lib_live_tools.js';

await connectMongo();
const { conn, project, operations } = await buildConnSpec('shared_sharepointonline');
console.log(`project    : ${project}`);
console.log(`operations : ${operations.map((o) => `${o.id}(${o.agents})`).join(', ') || '(none)'}\n`);

const assertions = `
# ---- GetAllTables -> sharepoint_list_lists (2 agents) ----------------------------
r = T["sharepoint_list_lists"]()
if isinstance(r, dict) and r.get("error"):
    fail("GetAllTables", r["error"])
    low = str(r["error"]).lower()
    if "denied" in low or "403" in low or "forbidden" in low:
        print("")
        print("      VERDICT: a TENANT GRANT is missing (Sites.Read.All application), not a bug.")
else:
    check("GetAllTables -> list_lists", r,
          lambda x: isinstance(x.get("lists") or x.get("tables") or x.get("value"), list),
          note=str(r.get("count") or len(r.get("lists") or r.get("tables") or []))[:40])
    rows = r.get("lists") or r.get("tables") or []
    # A list the agent cannot NAME is not an answer to "what lists are on the site?".
    if rows and any(str(x.get("name") or x.get("displayName") or "").strip() for x in rows):
        ok("lists carry names", ", ".join(
            str(x.get("name") or x.get("displayName")) for x in rows[:4]))
    elif rows:
        fail("lists carry names", json.dumps(rows[:2], default=str)[:70])
    else:
        ok("site has no lists", "call succeeded and returned an empty set")

# ---- the two read tools that back every SharePoint knowledge source -------------
r = T["sharepoint_list_files"]()
check("list files at the site root", r,
      lambda x: isinstance(x.get("files") or x.get("items") or x.get("value"), list),
      note=f"{len(r.get('files') or r.get('items') or [])} item(s)")
files = r.get("files") or r.get("items") or []

# Read the first thing that looks like text, and assert real content came back — a read
# tool that returns an empty string for every file passes a "no error" check.
target = None
for f in files:
    nm = str(f.get("name") or f.get("path") or "")
    if nm.lower().endswith((".txt", ".md", ".csv", ".docx", ".pdf")):
        target = f
        break
if target:
    path = str(target.get("path") or target.get("name"))
    r = T["sharepoint_read_file"](file_path=path)
    text = str(r.get("text") or r.get("content") or "")
    if isinstance(r, dict) and r.get("error"):
        fail("read a real document", str(r["error"])[:70])
    elif len(text.strip()) > 0:
        ok("read a real document", f"{path} -> {len(text)} char(s)")
    else:
        fail("read a real document", f"{path} returned no text at all")
else:
    ok("no readable document at the site root", f"{len(files)} item(s), none a text format")

# ---- negative cases --------------------------------------------------------------
print("")
print("      negative cases (an honest error is a PASS):")
for label, call in [
    ("empty file path", lambda: T["sharepoint_read_file"](file_path="")),
    ("file that does not exist", lambda: T["sharepoint_read_file"](file_path="nope/nothing-here.txt")),
]:
    out = call()
    honest = isinstance(out, dict) and bool(out.get("error"))
    if honest:
        ok(f"  {label}", str(out.get("error"))[:58])
    else:
        fail(f"  {label}", f"no error where one was required: {json.dumps(out, default=str)[:56]}")
`;

report(runToolAssertions(conn, project, assertions));
