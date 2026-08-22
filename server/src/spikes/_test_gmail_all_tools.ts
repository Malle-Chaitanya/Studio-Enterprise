/**
 * Exercise ALL 15 Gmail tools against a real mailbox, through the shipped build_tools
 * contract — the same code path adk_deploy.py runs inside the container.
 *
 * SELF-CONTAINED BY DESIGN. Every message this creates is addressed to the mailbox itself,
 * so the send/reply/forward tools are genuinely exercised without a single mail reaching
 * another human. Everything created is trashed at the end. Nothing touches real
 * correspondence: the read-only tools query, and the destructive ones only ever act on ids
 * this run produced.
 *
 * Requires the gmail.modify scope on the DWD grant.
 *
 *   cd server && npx tsx src/spikes/_test_gmail_all_tools.ts [subject]
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SUBJECT = process.argv[2] || 'zara@storefuze.com';
const KEY_FILE = resolve(process.env.GOOGLE_SA_KEY_FILE || './service_account.json');
const SCRIPTS = resolve('./scripts');

const py = `
import json, sys, time
sys.path.insert(0, r"${SCRIPTS.replace(/\\/g, '\\\\')}")
from connector_tools.gmail import build_tools

SUBJECT = "${SUBJECT}"
info = json.load(open(r"${KEY_FILE.replace(/\\/g, '\\\\')}"))
MARK = "CSGE-TOOLTEST"

def mint_token(fill=None):
    import google.auth.transport.requests
    from google.oauth2 import service_account
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/gmail.modify"]
    ).with_subject(SUBJECT)
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token

def secret(name):
    return SUBJECT if name == "impersonate_email" else ""

T = {t.__name__: t for t in build_tools({"kind": "gmail"}, secret, mint_token, None, lambda s: s)}
print(f"{len(T)} tools loaded\\n")

passed, failed, created = 0, [], []

def check(name, result, *, want=None, note=""):
    global passed
    if isinstance(result, dict) and result.get("error"):
        failed.append((name, result["error"]))
        print(f"FAIL  {name:26s} {result['error'][:80]}")
        return False
    if want and not want(result):
        failed.append((name, f"unexpected shape: {json.dumps(result)[:110]}"))
        print(f"FAIL  {name:26s} unexpected: {json.dumps(result)[:80]}")
        return False
    passed += 1
    print(f"PASS  {name:26s} {note}")
    return True

# ---- 1-3 read -------------------------------------------------------------
r = T["gmail_list_labels"]()
check("gmail_list_labels", r, want=lambda x: x.get("count", 0) > 0, note=f"{r.get('count')} labels")

r = T["gmail_search_messages"](query="", max_results=3)
check("gmail_search_messages", r, want=lambda x: "messages" in x, note=f"{r.get('count')} messages")
first_id = r["messages"][0]["id"] if r.get("messages") else None

if first_id:
    r = T["gmail_read_message"](message_id=first_id)
    check("gmail_read_message", r, want=lambda x: "subject" in x, note=f"subject={str(r.get('subject'))[:34]!r}")

# ---- 4 attachments (listing mode; no attachment needed) --------------------
if first_id:
    r = T["gmail_get_attachment"](message_id=first_id)
    check("gmail_get_attachment", r, want=lambda x: "attachments" in x or "filename" in x,
          note=f"{r.get('count', '-')} attachment(s)")

# ---- 5-8 drafts -----------------------------------------------------------
r = T["gmail_create_draft"](to=SUBJECT, subject=f"{MARK} draft", body="draft body v1")
ok = check("gmail_create_draft", r, want=lambda x: x.get("draftId"), note=f"draftId={r.get('draftId')}")
draft_id = r.get("draftId") if ok else None

r = T["gmail_list_drafts"]()
check("gmail_list_drafts", r, want=lambda x: "drafts" in x, note=f"{r.get('count')} drafts")

if draft_id:
    r = T["gmail_update_draft"](draft_id=draft_id, to=SUBJECT,
                                subject=f"{MARK} draft edited", body="draft body v2")
    check("gmail_update_draft", r, want=lambda x: x.get("updated"), note="edited")
    draft_id = r.get("draftId", draft_id)

if draft_id:
    r = T["gmail_send_draft"](draft_id=draft_id)
    if check("gmail_send_draft", r, want=lambda x: x.get("sent"), note=f"id={r.get('id')}"):
        created.append(r.get("id"))

# ---- 9 send ---------------------------------------------------------------
r = T["gmail_send_message"](to=SUBJECT, subject=f"{MARK} direct", body="sent by the tool test")
if check("gmail_send_message", r, want=lambda x: x.get("sent"), note=f"id={r.get('id')}"):
    created.append(r.get("id"))
sent_id = r.get("id")

time.sleep(3)  # delivery to self is fast but not instant

# ---- 10-11 reply / forward (both self-addressed) --------------------------
if sent_id:
    r = T["gmail_reply_to_message"](message_id=sent_id, body="replying to my own test")
    if check("gmail_reply_to_message", r, want=lambda x: x.get("sent"), note=f"thread={r.get('threadId')}"):
        created.append(r.get("id"))

    r = T["gmail_forward_message"](message_id=sent_id, to=SUBJECT, comment="forwarding my own test")
    if check("gmail_forward_message", r, want=lambda x: x.get("sent"),
             note=f"dropped={r.get('attachmentsDropped')}"):
        created.append(r.get("id"))

# ---- 12-14 organise -------------------------------------------------------
if sent_id:
    r = T["gmail_mark_read"](message_id=sent_id, read=False)
    check("gmail_mark_read(unread)", r, want=lambda x: "UNREAD" in x.get("labels", []), note="marked unread")

    r = T["gmail_mark_read"](message_id=sent_id, read=True)
    check("gmail_mark_read(read)", r, want=lambda x: "UNREAD" not in x.get("labels", []), note="marked read")

    r = T["gmail_star_message"](message_id=sent_id, starred=True)
    check("gmail_star_message", r, want=lambda x: "STARRED" in x.get("labels", []), note="starred")

    r = T["gmail_modify_labels"](message_id=sent_id, add_labels="IMPORTANT", remove_labels="STARRED")
    check("gmail_modify_labels", r,
          want=lambda x: "IMPORTANT" in x.get("labels", []) and "STARRED" not in x.get("labels", []),
          note="+IMPORTANT -STARRED")

# ---- 15 trash (also the cleanup) ------------------------------------------
for i, mid in enumerate([m for m in created if m]):
    r = T["gmail_trash_message"](message_id=mid)
    if i == 0:
        check("gmail_trash_message", r, want=lambda x: x.get("trashed"), note=f"trashed {mid}")

# sweep anything the run created that is still in the inbox
left = T["gmail_search_messages"](query=f"subject:{MARK}", max_results=25)
for m in left.get("messages", []):
    T["gmail_trash_message"](message_id=m["id"])
for d in T["gmail_list_drafts"]().get("drafts", []):
    if MARK in str(d.get("subject", "")):
        print(f"      NOTE: leftover draft {d['draftId']} — no delete-draft tool by design")

print(f"\\n{passed} passed, {len(failed)} failed")
for n, e in failed:
    print(f"  FAILED {n}: {e[:150]}")
print(f"cleanup: {len([m for m in created if m])} test message(s) trashed")
`;

const res = spawnSync('python', ['-c', py], { encoding: 'utf8', timeout: 300_000 });
if (res.stdout) console.log(res.stdout.trim());
if (res.stderr?.trim()) console.log('--- stderr ---\n' + res.stderr.trim().slice(0, 2500));
process.exit(0);
