/**
 * Exercise ALL FOUR Confluence tools against the customer's real instance, through the
 * shipped build_tools contract — the same code path adk_deploy.py runs in the container.
 *
 * Deliberately before any deploy. Every failure this project has paid a 5-minute deploy cycle
 * to discover (a missing token URL, a $top Graph rejects, a helper that pickled by reference)
 * was catchable at this layer in seconds.
 *
 * READ-ONLY. All four tools are reads; nothing here creates, edits or deletes a page.
 *
 *   cd server && npx tsx src/spikes/_test_confluence_all_tools.ts
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

const SCRIPTS = resolve('./scripts');

await connectMongo();
const db = getDb();
// Read the credential by RECORD, not through a session: migrationSessions has a Mongo TTL and
// a session-derived lookup reports "nothing configured" the moment it expires.
const rec = (await db.collection('connectorCredentials').findOne({ connectorId: 'shared_confluence' })) as
  | { appUserId?: string; project?: string; secretIds?: Record<string, string> } | null;
if (!rec?.secretIds) { console.log('no Confluence credential recorded'); process.exit(1); }
const project = rec.project ?? 'studio-enterprise-migration';
const saToken = await getSaToken();

const creds: Record<string, string> = {};
for (const [field, secretId] of Object.entries(rec.secretIds)) {
  const got = await getEntraSecret(saToken, `projects/${project}/secrets/${secretId}/versions/latest`);
  if (got.ok && got.plaintext) creds[field] = got.plaintext;
}
for (const f of ['base_url', 'email', 'api_token']) {
  if (!creds[f]) { console.log(`credential field ${f} is missing — cannot test`); process.exit(1); }
}
console.log(`site  : ${creds.base_url}`);
console.log(`as    : ${creds.email}\n`);

// base64, NOT inline JSON: interpolating values into Python source mangles anything
// containing a quote or a backslash, and an API token legitimately can.
const b64 = Buffer.from(JSON.stringify(creds), 'utf8').toString('base64');

const py = `
import base64, json, sys
sys.path.insert(0, r"${SCRIPTS.replace(/\\/g, '\\\\')}")
from connector_tools.confluence import build_tools

CREDS = json.loads(base64.b64decode("${b64}").decode())
def secret(name):
    return CREDS.get(name, "")

tools = build_tools({"kind": "confluence"}, secret, lambda f=None: "", None, lambda s: s)
T = {t.__name__: t for t in tools}
print(f"{len(T)} tools loaded: {', '.join(sorted(T))}\\n")

passed, failed = 0, []
def check(name, result, *, want=None, note=""):
    global passed
    if isinstance(result, dict) and result.get("error"):
        failed.append((name, str(result["error"]))); print(f"FAIL  {name:34s} {str(result['error'])[:80]}"); return False
    if want and not want(result):
        failed.append((name, json.dumps(result)[:110])); print(f"FAIL  {name:34s} unexpected: {json.dumps(result)[:70]}"); return False
    passed += 1; print(f"PASS  {name:34s} {note}"); return True

# ---- GetSpaces ---------------------------------------------------------------------
r = T["confluence_list_spaces"](max_results=100)
check("list_spaces", r, want=lambda x: x.get("count", 0) > 0, note=f"{r.get('count')} space(s)")
spaces = r.get("spaces", [])

# A TEAM space, not a personal one — personal spaces are usually empty and would make an
# empty page list look like a broken tool.
team = [s for s in spaces if not str(s.get("key") or "").startswith("~")]
print(f"      {len(team)} team space(s), {len(spaces) - len(team)} personal")

# ---- GetPagesBySpace, by KEY and by NAME -------------------------------------------
page_id = None
target = None
for sp in team:
    r = T["confluence_list_pages_in_space"](space=sp["key"], max_results=10)
    if not r.get("error") and r.get("count", 0) > 0:
        target = sp
        page_id = r["pages"][0]["id"]
        check("list_pages_in_space (by key)", r, want=lambda x: x.get("count", 0) > 0,
              note=f"{r.get('count')} page(s) in {sp['key']}")
        break
if not target:
    print("SKIP  list_pages_in_space            no team space with readable pages")

if target:
    # The whole point of _resolve_space: a customer types the NAME.
    r = T["confluence_list_pages_in_space"](space=target["name"], max_results=5)
    check("list_pages_in_space (by NAME)", r, want=lambda x: x.get("count", 0) > 0,
          note=f"resolved \\"{target['name']}\\" -> {r.get('space')}")

# ---- GetPages / GetPageMetadata ----------------------------------------------------
if page_id:
    r = T["confluence_get_page"](page_id=page_id, include_body=True)
    check("get_page (with body)", r, want=lambda x: x.get("title"),
          note=f"\\"{str(r.get('title'))[:34]}\\" v{r.get('version')} {len(str(r.get('text') or ''))}ch")
    r = T["confluence_get_page"](page_id=page_id, include_body=False)
    check("get_page (metadata only)", r, want=lambda x: x.get("title") and "text" not in x,
          note="no body returned, as asked")

# ---- existing search still works ---------------------------------------------------
r = T["confluence_live_search"](query="migration")
check("live_search", r, want=lambda x: "results" in x, note=f"{r.get('count')} hit(s)")

# ---- negative cases: must refuse clearly, not guess --------------------------------
print("\\n      negative cases (an honest error is a PASS):")
for label, call in [
    ("unknown space name", lambda: T["confluence_list_pages_in_space"](space="No Such Space Xyzzy")),
    ("empty space",        lambda: T["confluence_list_pages_in_space"](space="")),
    ("empty page id",      lambda: T["confluence_get_page"](page_id="")),
    ("bogus page id",      lambda: T["confluence_get_page"](page_id="999999999999")),
]:
    out = call()
    ok = isinstance(out, dict) and bool(out.get("error"))
    print(f"      {'PASS' if ok else 'FAIL'}  {label:22s} {str(out.get('error') or out)[:74]}")
    if ok: passed += 1
    else: failed.append((label, "no error where one was required"))

print(f"\\n{passed} passed, {len(failed)} failed")
for n, e in failed:
    print(f"  FAILED {n}: {e[:150]}")
`;

const res = spawnSync('python', ['-c', py], { encoding: 'utf8', timeout: 300_000 });
if (res.stdout) console.log(res.stdout.trim());
if (res.stderr?.trim()) console.log('--- stderr ---\n' + res.stderr.trim().slice(0, 2000));
process.exit(0);
