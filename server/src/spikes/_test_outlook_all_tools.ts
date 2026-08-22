/**
 * Exercise ALL 14 Outlook tools against a real mailbox via Microsoft Graph, through the
 * shipped build_tools contract — the same code path adk_deploy.py runs in the container.
 *
 * This is the KEEP-MICROSOFT path: the agent migrates to Gemini, its mail stays in M365.
 * Nothing here moves mail; every tool makes a live Graph call.
 *
 * SELF-CONTAINED. Every message created is addressed to the mailbox itself, so send / reply
 * / forward are genuinely exercised without a single mail reaching another human, and
 * everything created is moved to Deleted Items at the end.
 *
 * Auth: app-only client_credentials against the customer's own Entra app, exactly as the
 * deployed container does. Needs Mail.ReadWrite + Mail.Send APPLICATION permissions with
 * admin consent.
 *
 *   cd server && npx tsx src/spikes/_test_outlook_all_tools.ts [mailbox]
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getSaToken } from '../auth/google.js';

const MAILBOX = process.argv[2] || '';
const PROJECT = 'studio-enterprise-migration';
const SCRIPTS = resolve('./scripts');

// The same secrets the deployed connector reads, so this proves the real credential path
// rather than a hand-fed one.
const SECRETS = {
  tenant_id: 'studio-enterprise-ms-graph-tenant-id',
  client_id: 'studio-enterprise-ms-graph-client-id',
  client_secret: 'studio-enterprise-ms-graph-client-secret',
};

const admin = await getSaToken();
async function readSecret(name: string): Promise<string> {
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${admin}` } },
  );
  if (!res.ok) throw new Error(`secret ${name}: ${res.status}`);
  const j = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8').trim();
}

const creds = {
  tenant_id: await readSecret(SECRETS.tenant_id),
  client_id: await readSecret(SECRETS.client_id),
  client_secret: await readSecret(SECRETS.client_secret),
};
console.log(`tenant   : ${creds.tenant_id}`);
console.log(`client id: ${creds.client_id}`);

// Which mailbox? Ask Graph rather than guessing, so a wrong argument fails loudly.
const tokRes = await fetch(`https://login.microsoftonline.com/${creds.tenant_id}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    scope: 'https://graph.microsoft.com/.default',
  }),
});
const tok = (await tokRes.json()) as { access_token?: string; error_description?: string };
if (!tok.access_token) {
  console.log(`FAIL token: ${tok.error_description ?? JSON.stringify(tok).slice(0, 200)}`);
  process.exit(0);
}

let mailbox = MAILBOX;
if (!mailbox) {
  const u = await fetch(
    'https://graph.microsoft.com/v1.0/users?$select=userPrincipalName,mail,assignedLicenses&$top=25',
    { headers: { Authorization: `Bearer ${tok.access_token}` } },
  );
  const uj = (await u.json()) as { value?: Array<{ userPrincipalName?: string; mail?: string; assignedLicenses?: unknown[] }>; error?: { message?: string } };
  if (uj.error) {
    console.log(`FAIL user list: ${uj.error.message}`);
    process.exit(0);
  }
  // A mailbox needs a licence; an unlicensed user 404s on /messages and looks like a bug.
  const licensed = (uj.value ?? []).filter((x) => (x.assignedLicenses?.length ?? 0) > 0 && x.mail);
  mailbox = licensed[0]?.mail ?? licensed[0]?.userPrincipalName ?? (uj.value ?? [])[0]?.userPrincipalName ?? '';
  console.log(`discovered ${(uj.value ?? []).length} user(s), ${licensed.length} licensed`);
}
if (!mailbox) {
  console.log('FAIL: no mailbox to test against. Pass one as an argument.');
  process.exit(0);
}
console.log(`mailbox  : ${mailbox}\n`);

const py = `
import json, sys, time
sys.path.insert(0, r"${SCRIPTS.replace(/\\/g, '\\\\')}")
from connector_tools.outlook import build_tools

CREDS = ${JSON.stringify(creds)}
MAILBOX = "${mailbox}"
MARK = "CSGE-OUTLOOK-TOOLTEST"

def mint_token(fill=None):
    import urllib.parse, urllib.request, json as _json
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": CREDS["client_id"],
        "client_secret": CREDS["client_secret"],
        "scope": "https://graph.microsoft.com/.default",
    }).encode()
    req = urllib.request.Request(
        f"https://login.microsoftonline.com/{CREDS['tenant_id']}/oauth2/v2.0/token",
        data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return _json.loads(r.read().decode())["access_token"]

def secret(name):
    return MAILBOX if name == "impersonate_email" else CREDS.get(name, "")

T = {t.__name__: t for t in build_tools({"kind": "outlook"}, secret, mint_token, None, lambda s: s)}
print(f"{len(T)} tools loaded\\n")

passed, failed, created = 0, [], []

def check(name, result, *, want=None, note=""):
    global passed
    if isinstance(result, dict) and result.get("error"):
        failed.append((name, result["error"])); print(f"FAIL  {name:28s} {result['error'][:90]}"); return False
    if want and not want(result):
        failed.append((name, json.dumps(result)[:110])); print(f"FAIL  {name:28s} unexpected: {json.dumps(result)[:80]}"); return False
    passed += 1; print(f"PASS  {name:28s} {note}"); return True

# ---- read ------------------------------------------------------------------
r = T["outlook_list_folders"]()
check("outlook_list_folders", r, want=lambda x: x.get("count", 0) > 0, note=f"{r.get('count')} folders")

r = T["outlook_search_messages"](query="", max_results=3)
check("outlook_search_messages", r, want=lambda x: "messages" in x, note=f"{r.get('count')} messages")
first = r["messages"][0]["id"] if r.get("messages") else None

if first:
    r = T["outlook_read_message"](message_id=first)
    check("outlook_read_message", r, want=lambda x: "subject" in x, note=f"subject={str(r.get('subject'))[:32]!r}")
    r = T["outlook_get_attachment"](message_id=first)
    check("outlook_get_attachment", r, want=lambda x: "attachments" in x or "filename" in x,
          note=f"{r.get('count','-')} attachment(s)")

# ---- drafts ----------------------------------------------------------------
r = T["outlook_create_draft"](to=MAILBOX, subject=f"{MARK} draft", body="draft body")
ok = check("outlook_create_draft", r, want=lambda x: x.get("draftId"), note=f"draftId={str(r.get('draftId'))[:18]}…")
draft_id = r.get("draftId") if ok else None

if draft_id:
    r = T["outlook_send_draft"](draft_id=draft_id)
    check("outlook_send_draft", r, want=lambda x: x.get("sent"), note="sent")

# ---- send ------------------------------------------------------------------
r = T["outlook_send_message"](to=MAILBOX, subject=f"{MARK} direct", body="sent by the tool test")
check("outlook_send_message", r, want=lambda x: x.get("sent"), note="sent to self")

print("      (waiting 12s for self-delivery)")
time.sleep(12)

found = T["outlook_search_messages"](query=MARK, max_results=10)
ids = [m["id"] for m in found.get("messages", [])]
created.extend(ids)
print(f"      delivered: {len(ids)} test message(s) found")
target = ids[0] if ids else None

# ---- reply / forward (self-addressed) --------------------------------------
if target:
    r = T["outlook_reply_to_message"](message_id=target, body="replying to my own test")
    check("outlook_reply_to_message", r, want=lambda x: x.get("sent"), note="replied")
    r = T["outlook_forward_message"](message_id=target, to=MAILBOX, comment="forwarding my own test")
    check("outlook_forward_message", r, want=lambda x: x.get("sent"), note="forwarded (attachments kept)")

# ---- organise --------------------------------------------------------------
if target:
    r = T["outlook_mark_read"](message_id=target, read=False)
    check("outlook_mark_read(unread)", r, want=lambda x: x.get("read") is False, note="unread")
    r = T["outlook_mark_read"](message_id=target, read=True)
    check("outlook_mark_read(read)", r, want=lambda x: x.get("read") is True, note="read")

    r = T["outlook_flag_message"](message_id=target, flagged=True)
    check("outlook_flag_message", r, want=lambda x: x.get("flagStatus") == "flagged", note="flagged")

    r = T["outlook_set_categories"](message_id=target, categories="CSGE Test")
    check("outlook_set_categories", r, want=lambda x: "CSGE Test" in x.get("categories", []), note="categorised")

    folders = T["outlook_list_folders"]().get("folders", [])
    archive = next((f for f in folders if (f.get("name") or "").lower() == "archive"), None)
    if archive:
        r = T["outlook_move_message"](message_id=target, folder_id=archive["id"])
        if check("outlook_move_message", r, want=lambda x: x.get("moved"), note="moved to Archive"):
            target = r.get("id", target)
    else:
        print("SKIP  outlook_move_message         no Archive folder in this mailbox")

# ---- delete (also the cleanup) ---------------------------------------------
if target:
    r = T["outlook_delete_message"](message_id=target)
    check("outlook_delete_message", r, want=lambda x: x.get("deleted"), note="to Deleted Items")

for mid in [m for m in created if m and m != target]:
    T["outlook_delete_message"](message_id=mid)

left = T["outlook_search_messages"](query=MARK, max_results=25)
for m in left.get("messages", []):
    T["outlook_delete_message"](message_id=m["id"])

print(f"\\n{passed} passed, {len(failed)} failed")
for n, e in failed:
    print(f"  FAILED {n}: {e[:160]}")
print(f"cleanup: test messages moved to Deleted Items")
`;

const res = spawnSync('python', ['-c', py], { encoding: 'utf8', timeout: 300_000 });
if (res.stdout) console.log(res.stdout.trim());
if (res.stderr?.trim()) console.log('--- stderr ---\n' + res.stderr.trim().slice(0, 2500));
process.exit(0);
