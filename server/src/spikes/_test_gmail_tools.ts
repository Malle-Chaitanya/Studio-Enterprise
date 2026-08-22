/**
 * Run the real gmail.py tools against a real mailbox, OUT of the deployment.
 *
 * Deployment is slow (a ~5 minute container build) and has its own failure modes, so
 * proving the tools here first means a later failure is unambiguous: if these pass and the
 * deployed agent fails, the bug is in deployment, not in the tools.
 *
 * Calls build_tools() with the same (conn, secret, mint_token, auth_header, fill) contract
 * adk_deploy.py uses at container runtime, so this exercises the shipped code path rather
 * than a reimplementation of it.
 *
 *   cd server && npx tsx src/spikes/_test_gmail_tools.ts [subject-email]
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SUBJECT = process.argv[2] || 'zara@storefuze.com';
const KEY_FILE = resolve(process.env.GOOGLE_SA_KEY_FILE || './service_account.json');
const SCRIPTS = resolve('./scripts');

// Mirrors adk_deploy.py's google-service-account branch: build credentials from the key,
// apply the DWD subject, and hand the tools a mint_token they can call.
const py = `
import json, sys
sys.path.insert(0, r"${SCRIPTS.replace(/\\/g, '\\\\')}")
from connector_tools.gmail import build_tools

SUBJECT = "${SUBJECT}"
info = json.load(open(r"${KEY_FILE.replace(/\\/g, '\\\\')}"))

def mint_token(fill=None):
    import google.auth.transport.requests
    from google.oauth2 import service_account
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/gmail.readonly"]
    ).with_subject(SUBJECT)
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token

def secret(name):
    return SUBJECT if name == "impersonate_email" else ""

tools = build_tools({"kind": "gmail"}, secret, mint_token, None, lambda s: s)
by_name = {t.__name__: t for t in tools}
print("TOOLS:", ", ".join(sorted(by_name)))

# 1. labels - cheapest real call, proves auth + shape
labels = by_name["gmail_list_labels"]()
if labels.get("error"):
    print("FAIL labels:", labels["error"]); sys.exit(0)
names = [l["name"] for l in labels["labels"]][:8]
print(f"PASS gmail_list_labels    mailbox={labels['mailbox']} count={labels['count']} e.g. {names}")

# 2. search - the operation that answers a real question
s = by_name["gmail_search_messages"](query="", max_results=3)
if s.get("error"):
    print("FAIL search:", s["error"]); sys.exit(0)
print(f"PASS gmail_search_messages count={s['count']} truncated={s['truncated']}")
for m in s["messages"]:
    print(f"       - {m['date'][:25]:25s} {m['from'][:34]:34s} {m['subject'][:40]}")

if not s["messages"]:
    print("NOTE  mailbox is empty - cannot exercise gmail_read_message"); sys.exit(0)

# 3. read - full body decode through the MIME walk
mid = s["messages"][0]["id"]
r = by_name["gmail_read_message"](message_id=mid)
if r.get("error"):
    print("FAIL read:", r["error"]); sys.exit(0)
body = (r.get("body") or "").replace("\\n", " ")[:160]
print(f"PASS gmail_read_message   subject={r['subject'][:50]!r}")
print(f"       labels={r['labels'][:5]} attachments={r['attachments'][:3]} truncated={r['truncated']}")
print(f"       body[:160]={body!r}")
if not r.get("body"):
    print("       NOTE: no text body decoded - check the MIME walk against this message")

# 4. a query that should match nothing - the empty path must be a clean answer, not an error
z = by_name["gmail_search_messages"](query="from:nobody-" + "x"*12 + "@example.invalid")
print(f"PASS empty-result path    count={z['count']} note={z.get('note','')[:60]!r} error={z.get('error')}")
`;

const res = spawnSync('python', ['-c', py], { encoding: 'utf8', timeout: 180_000 });
if (res.stdout) console.log(res.stdout.trim());
if (res.stderr?.trim()) console.log('--- stderr ---\n' + res.stderr.trim().slice(0, 2000));
process.exit(0);
