/**
 * Exercise ALL 11 Google Chat tools against a real Workspace, through the shipped
 * build_tools contract — the same code path adk_deploy.py runs in the container.
 *
 * Deliberately run BEFORE any deploy. Every failure this session that cost a 5-minute deploy
 * cycle (doseq, $top, a missing token URL) was catchable at this layer in seconds. Proving
 * tools at the API boundary first, then deploying, is the cheaper order.
 *
 * SELF-CONTAINED and low-blast-radius: it creates its own space, does all writing inside
 * that space, and never posts into a space it did not create. Chat has no "delete space"
 * tool here on purpose, so the probe space is left behind — named so it is obvious.
 *
 *   cd server && npx tsx src/spikes/_test_chat_all_tools.ts [subject-email]
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const SUBJECT = process.argv[2] || 'zara@storefuze.com';
const SCRIPTS = resolve('./scripts');

const keyFile = process.env.GOOGLE_SA_KEY_FILE || './service_account.json';
const keyJson = process.env.GOOGLE_SA_KEY_JSON || readFileSync(keyFile, 'utf8');
const parsed = JSON.parse(keyJson) as { client_email?: string };
console.log(`service account : ${parsed.client_email}`);
console.log(`impersonating   : ${SUBJECT}\n`);

const py = `
import json, sys, time
sys.path.insert(0, r"${SCRIPTS.replace(/\\/g, '\\\\')}")
from connector_tools.chat import build_tools

# base64, NOT inline JSON: interpolating the key into Python source mangles the newlines
# inside private_key and every call then fails with "Unable to load PEM file".
import base64
SA = json.loads(base64.b64decode("${Buffer.from(keyJson, 'utf8').toString('base64')}").decode())
SUBJECT = "${SUBJECT}"
MARK = "CSGE-CHAT-TOOLTEST"

def mint_token(fill=None):
    from google.oauth2 import service_account
    import google.auth.transport.requests
    creds = service_account.Credentials.from_service_account_info(
        SA, scopes=["https://www.googleapis.com/auth/chat.spaces",
                    "https://www.googleapis.com/auth/chat.messages"])
    creds = creds.with_subject(SUBJECT)
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token

def secret(name):
    return SUBJECT if name == "impersonate_email" else ""

T = {t.__name__: t for t in build_tools({"kind": "googlechat"}, secret, mint_token, None, lambda s: s)}
print(f"{len(T)} tools loaded\\n")

passed, failed = 0, []

def check(name, result, *, want=None, note=""):
    global passed
    if isinstance(result, dict) and result.get("error"):
        failed.append((name, result["error"])); print(f"FAIL  {name:26s} {result['error'][:90]}"); return False
    if want and not want(result):
        failed.append((name, json.dumps(result)[:110])); print(f"FAIL  {name:26s} unexpected: {json.dumps(result)[:80]}"); return False
    passed += 1; print(f"PASS  {name:26s} {note}"); return True

# ---- read ------------------------------------------------------------------
r = T["chat_list_spaces"]()
check("chat_list_spaces", r, want=lambda x: x.get("count", 0) > 0, note=f"{r.get('count')} spaces")
existing = r.get("spaces", [])

r = T["chat_find_direct_message"](user_email=SUBJECT)
# Chat's self-DM: the row in the equivalence table says this is EXPECTED to work but was
# never verified. This is the verification.
if isinstance(r, dict) and r.get("error"):
    print(f"NOTE  chat_find_direct_message(self) -> {r['error'][:80]}")
    print("      Self-DM is the unverified row in the table. Recording, not asserting.")
else:
    check("chat_find_direct_message", r, want=lambda x: x.get("space"), note="self-DM found")

# ---- create our own space, so every write is contained ---------------------
r = T["chat_create_space"](name=f"{MARK} {int(time.time()) % 100000}")
ok = check("chat_create_space", r, want=lambda x: x.get("space"), note=f"space={r.get('space')}")
space = r.get("space") if ok else None

if space:
    r = T["chat_send_message"](space_id=space, text=f"{MARK} hello from the tool test")
    sent = check("chat_send_message", r, want=lambda x: x.get("sent"), note=f"id={str(r.get('id'))[-12:]}")
    msg_id = r.get("id") if sent else None

    r = T["chat_list_messages"](space_id=space, max_results=5)
    check("chat_list_messages", r, want=lambda x: x.get("count", 0) >= 1, note=f"{r.get('count')} messages")

    if msg_id:
        r = T["chat_get_message"](message_id=msg_id)
        check("chat_get_message", r, want=lambda x: MARK in (x.get("text") or ""), note="text matches")

        r = T["chat_reply_to_message"](message_id=msg_id, text=f"{MARK} threaded reply")
        check("chat_reply_to_message", r,
              want=lambda x: x.get("sent"), note=f"threaded={r.get('threaded')}")

        r = T["chat_list_thread_replies"](message_id=msg_id)
        check("chat_list_thread_replies", r, want=lambda x: "messages" in x,
              note=f"threaded={r.get('threaded')} count={r.get('count')}")

        r = T["chat_update_message"](message_id=msg_id, text=f"{MARK} edited by the tool test")
        check("chat_update_message", r, want=lambda x: x.get("updated"), note="edited")

    r = T["chat_send_card"](space_id=space, title=f"{MARK} card", text="Display-only card.")
    check("chat_send_card", r, want=lambda x: x.get("sent") and x.get("interactive") is False,
          note="card posted, interactive=False")

    r = T["chat_list_members"](space_id=space)
    check("chat_list_members", r, want=lambda x: "members" in x, note=f"{r.get('count')} member(s)")

print(f"\\n{passed} passed, {len(failed)} failed")
for n, e in failed:
    print(f"  FAILED {n}: {e[:160]}")
if space:
    print(f"probe space left behind (no delete tool by design): {space}")
`;

const res = spawnSync('python', ['-c', py], { encoding: 'utf8', timeout: 300_000 });
if (res.stdout) console.log(res.stdout.trim());
if (res.stderr?.trim()) console.log('--- stderr ---\n' + res.stderr.trim().slice(0, 2500));
process.exit(0);
