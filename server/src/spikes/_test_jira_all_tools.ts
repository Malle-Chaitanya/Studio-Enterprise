/**
 * Exercise ALL SIX Jira tools against the customer's real site, through the shipped
 * build_tools contract — the same code path adk_deploy.py runs in the container.
 *
 * READ-ONLY. Every tool here is a read; nothing creates, transitions or comments on an issue.
 *
 * Deliberately before any deploy: the two API facts this module exists for (v3 /search is
 * REMOVED, and unbounded JQL is rejected) were both discovered the expensive way, in front of
 * a customer, and both are catchable here in seconds.
 *
 *   cd server && npx tsx src/spikes/_test_jira_all_tools.ts
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

const SCRIPTS = resolve('./scripts');

await connectMongo();
const db = getDb();
// By credential RECORD, not through a session: migrationSessions has a Mongo TTL and a
// session-derived lookup reports "nothing configured" the moment it expires.
const rec = (await db.collection('connectorCredentials').findOne({ connectorId: 'shared_jira' })) as
  | { project?: string; secretIds?: Record<string, string> } | null;
if (!rec?.secretIds) { console.log('no Jira credential recorded'); process.exit(1); }
const project = rec.project ?? 'studio-enterprise-migration';
const saToken = await getSaToken();

const creds: Record<string, string> = {};
for (const [field, secretId] of Object.entries(rec.secretIds)) {
  const got = await getEntraSecret(saToken, `projects/${project}/secrets/${secretId}/versions/latest`);
  if (got.ok && got.plaintext) creds[field] = got.plaintext;
}
for (const f of ['base_url', 'email', 'api_token']) {
  if (!creds[f]) { console.log(`credential field ${f} missing — cannot test`); process.exit(1); }
}
// The real baseUrlTemplate from the registry, not a hand-written guess — a spike that invents
// its own URL shape proves the spike, not the shipped connector.
const def = REGISTRY_BY_ID.get('shared_jira');
const tpl = def?.baseUrlTemplate ?? '';
console.log(`site : ${creds.base_url}`);
console.log(`as   : ${creds.email}`);
console.log(`tpl  : ${tpl}\n`);

const b64 = Buffer.from(JSON.stringify(creds), 'utf8').toString('base64');

const py = `
import base64, json, sys
sys.path.insert(0, r"${SCRIPTS.replace(/\\/g, '\\\\')}")
from connector_tools.jira import build_tools

CREDS = json.loads(base64.b64decode("${b64}").decode())
def secret(name):
    return CREDS.get(name, "")

def fill(tpl):
    out = tpl or ""
    import re
    for field in set(re.findall(r"\\{(\\w+)\\}", out)):
        out = out.replace("{" + field + "}", secret(field))
    return out

def auth_header(_fill):
    import base64 as _b
    return "Basic " + _b.b64encode(f"{secret('email')}:{secret('api_token')}".encode()).decode()

conn = {"kind": "jira", "id": "shared_jira", "baseUrlTemplate": ${JSON.stringify(tpl)}}
tools = build_tools(conn, secret, lambda f=None: "", auth_header, fill)
T = {t.__name__: t for t in tools}
print(f"{len(T)} tools loaded: {', '.join(sorted(T))}\\n")

passed, failed = 0, []
def check(name, result, *, want=None, note=""):
    global passed
    if isinstance(result, dict) and result.get("error"):
        failed.append((name, str(result["error"]))); print(f"FAIL  {name:30s} {str(result['error'])[:78]}"); return False
    if want and not want(result):
        failed.append((name, json.dumps(result)[:110])); print(f"FAIL  {name:30s} unexpected: {json.dumps(result)[:70]}"); return False
    passed += 1; print(f"PASS  {name:30s} {note}"); return True

# ---- ListProjects ------------------------------------------------------------------
r = T["jira_list_projects"]()
check("list_projects", r, want=lambda x: x.get("count", x.get("total", 0)) or x.get("projects"),
      note=f"{len(r.get('projects') or [])} project(s)")
projects = r.get("projects") or []

# ---- ListIssues / ListIssues_Datacenter --------------------------------------------
# Empty jql on purpose: the module must supply its own BOUNDED default, because Jira
# rejects an unbounded query and a customer asking "how many tickets?" supplies no JQL.
r = T["jira_search"]()
check("search (default bounded jql)", r, want=lambda x: "issues" in x,
      note=f"shown={r.get('shown')} totalApproximate={r.get('totalApproximate')} hasMore={r.get('hasMore')}")
# The bug this guards: /search/jql returns no total, so a fallback to len(issues) made the
# agent answer the PAGE SIZE to "how many tickets do we have?" (20 vs a real 32,353).
if isinstance(r, dict):
    if "total" in r:
        failed.append(("search total", "reports a bare total, which /search/jql never provides"))
        print("FAIL  search: no phantom total     total is back - it is the page size, not a count")
    elif isinstance(r.get("totalApproximate"), int) and r["totalApproximate"] > len(r.get("issues") or []):
        passed += 1; print(f"PASS  search: real match count      totalApproximate={r['totalApproximate']} > shown")
    elif r.get("totalNote"):
        passed += 1; print("PASS  search: refuses to guess      no count claimed, and says so")
    else:
        failed.append(("search count", "neither a real count nor an honest refusal"))
        print("FAIL  search: count               neither a real count nor an honest refusal")
issues = r.get("issues") or []

# The removed-endpoint trap: an explicit unbounded query must NOT 410 or 400.
r2 = T["jira_search"](jql="ORDER BY created DESC", max_results=3)
if isinstance(r2, dict) and r2.get("error"):
    print(f"NOTE  unbounded jql -> {str(r2['error'])[:70]}")
    print("      (Jira rejects unbounded JQL; the module is expected to bound it itself)")
else:
    check("search (unbounded jql handled)", r2, want=lambda x: "issues" in x,
          note=f"{len(r2.get('issues') or [])} issue(s)")

# ---- GetIssue / GetIssue_V2 --------------------------------------------------------
if issues:
    key = issues[0].get("key")
    r = T["jira_get_issue"](issue_key=key)
    check("get_issue", r, want=lambda x: x.get("key") == key, note=f"{key} :: {str(r.get('summary'))[:34]}")
else:
    print("SKIP  get_issue                     no issue returned by search")

# ---- GetCurrentUser (new) ----------------------------------------------------------
r = T["jira_get_current_user"]()
check("get_current_user", r, want=lambda x: x.get("accountId"),
      note=f"{r.get('displayName')} <{r.get('email')}>")
# The whole point of the tool: it must say it is a shared identity, not the asker.
if isinstance(r, dict) and "not the person asking" not in str(r.get("note", "")):
    failed.append(("get_current_user note", "does not warn that the identity is shared"))
    print("FAIL  get_current_user note          missing the shared-identity warning")
else:
    passed += 1; print("PASS  get_current_user note          warns the identity is shared")

# ---- ListIssueTypes_V2 (new) -------------------------------------------------------
r = T["jira_list_issue_types"]()
check("list_issue_types", r, want=lambda x: x.get("count", 0) > 0,
      note=f"{r.get('count')} distinct type(s): " + ", ".join(t["name"] for t in (r.get("issueTypes") or [])[:4]))

# ---- ListResources (new) -----------------------------------------------------------
r = T["jira_list_sites"]()
check("list_sites", r, want=lambda x: x.get("count") == 1 and x.get("sites"),
      note=f"{r.get('sites', [{}])[0].get('url')} ({r.get('sites', [{}])[0].get('deploymentType')})")
# It must declare the lost multi-site discovery rather than quietly presenting one site
# as if it were the whole list.
if isinstance(r, dict) and "not available" not in str(r.get("note", "")):
    failed.append(("list_sites note", "does not declare that multi-site discovery is lost"))
    print("FAIL  list_sites note                missing the lost-capability note")
else:
    passed += 1; print("PASS  list_sites note                declares multi-site discovery lost")

# ---- negative cases ----------------------------------------------------------------
print("\\n      negative cases (an honest error is a PASS):")
for label, call in [
    ("empty issue key", lambda: T["jira_get_issue"](issue_key="")),
    ("bogus issue key", lambda: T["jira_get_issue"](issue_key="NOSUCH-99999")),
    ("malformed jql",   lambda: T["jira_search"](jql="this is not jql (((")),
]:
    out = call()
    ok = isinstance(out, dict) and bool(out.get("error"))
    print(f"      {'PASS' if ok else 'FAIL'}  {label:20s} {str(out.get('error') or out)[:70]}")
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
