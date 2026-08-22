/**
 * Can our service account reach Google Chat as a USER, through domain-wide delegation?
 *
 * This is the gate on the whole Teams -> Google Chat path, and unlike Gmail it is genuinely
 * uncertain. Gmail works because DWD lets the SA become a person and a mailbox belongs to a
 * person. Chat documents its auth differently: it distinguishes "app authentication" (the SA
 * acting as a registered CHAT APP, which must be a member of every space it touches) from
 * "user authentication". Whether a DWD-impersonated subject counts as the latter is the
 * question, and it decides the product:
 *
 *   DWD works      -> the agent acts as a person, sees that person's spaces. Like Gmail.
 *   DWD refused    -> the SA must be registered as a Chat app and ADDED to each space, and
 *                     posts visibly as the app rather than as a person. Same code, very
 *                     different thing to sell.
 *
 * Layers, independent so a failure localises to a layer rather than "Chat is broken":
 *   1  plain SA token, no impersonation        baseline — the key itself is fine
 *   2  DWD token for admin.directory.*         proves DWD works AT ALL for this SA
 *   3  DWD token for chat.spaces               the new scope this path needs
 *   4  DWD token for chat.messages             the write scope
 *   5  spaces.list as the impersonated user    a REAL read: does it see their spaces?
 *   6  spaces.messages.list on the first space reading actual messages
 *
 * Layer 3 failing with `unauthorized_client` means the exact scope string is not in the
 * Workspace DWD grant — an admin action, not a code fix. Layer 5 failing while 3 succeeds
 * means the token is fine but Chat refuses impersonated user auth, which is the answer that
 * changes the product rather than the config.
 *
 * NEVER prints a token value — only whether one was obtained.
 *
 *   cd server && npx tsx src/spikes/_diag_chat_dwd_probe.ts [subject-email]
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';

const SUBJECT = process.argv[2] || 'zara@storefuze.com';

const CHAT_SPACES = 'https://www.googleapis.com/auth/chat.spaces';
const CHAT_MESSAGES = 'https://www.googleapis.com/auth/chat.messages';
const DIR_RO = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

function saCredentials(): { client_email: string; private_key: string; client_id?: string } {
  const raw = process.env.GOOGLE_SA_KEY_JSON;
  if (raw) return JSON.parse(raw);
  const file = process.env.GOOGLE_SA_KEY_FILE || './service_account.json';
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function mint(
  scopes: string[],
  subject?: string,
): Promise<{ ok: boolean; err?: string; token?: string }> {
  const sa = saCredentials();
  const client = new JWT({ email: sa.client_email, key: sa.private_key, scopes, subject });
  try {
    const res = await client.getAccessToken();
    return res?.token ? { ok: true, token: res.token } : { ok: false, err: 'no token in response' };
  } catch (e) {
    return { ok: false, err: (e as Error).message.replace(/\s+/g, ' ').slice(0, 240) };
  }
}

const sa = saCredentials();
console.log(`service account : ${sa.client_email}`);
console.log(`client id       : ${sa.client_id ?? '(not in key file)'}`);
console.log(`impersonating   : ${SUBJECT}\n`);

// ---- 1 baseline ------------------------------------------------------------------------
const l1 = await mint(['https://www.googleapis.com/auth/cloud-platform']);
console.log(l1.ok ? 'L1 PASS  plain SA token minted' : `L1 FAIL  ${l1.err}`);

// ---- 2 does DWD work at all ------------------------------------------------------------
const l2 = await mint([DIR_RO], SUBJECT);
console.log(
  l2.ok
    ? 'L2 PASS  DWD works for this SA (directory scope)'
    : `L2 FAIL  DWD refused for directory scope — ${l2.err}`,
);

// ---- 3/4 the Chat scopes ---------------------------------------------------------------
const l3 = await mint([CHAT_SPACES], SUBJECT);
console.log(
  l3.ok ? 'L3 PASS  chat.spaces token minted' : `L3 FAIL  chat.spaces — ${l3.err}`,
);
const l4 = await mint([CHAT_MESSAGES], SUBJECT);
console.log(
  l4.ok ? 'L4 PASS  chat.messages token minted' : `L4 FAIL  chat.messages — ${l4.err}`,
);

// ---- 5 a real read ---------------------------------------------------------------------
const both = await mint([CHAT_SPACES, CHAT_MESSAGES], SUBJECT);
let firstSpace = '';
if (!both.ok) {
  console.log(`L5 SKIP  no combined token — ${both.err}`);
} else {
  const res = await fetch('https://chat.googleapis.com/v1/spaces?pageSize=10', {
    headers: { Authorization: `Bearer ${both.token}` },
  });
  const body = await res.text();
  if (res.ok) {
    const j = JSON.parse(body) as {
      spaces?: Array<{ name: string; displayName?: string; spaceType?: string }>;
    };
    const spaces = j.spaces ?? [];
    console.log(`L5 PASS  spaces.list returned ${spaces.length} space(s) for ${SUBJECT}`);
    for (const s of spaces.slice(0, 5)) {
      console.log(`         ${s.spaceType ?? '?'}  ${s.displayName || '(direct message)'}  ${s.name}`);
    }
    firstSpace = spaces[0]?.name ?? '';
  } else {
    console.log(`L5 FAIL  spaces.list ${res.status}`);
    console.log(`         ${body.replace(/\s+/g, ' ').slice(0, 400)}`);
    // The distinction that matters for the product, called out explicitly so the result is
    // not misread as a config problem.
    if (/service accounts|app authentication|not supported/i.test(body)) {
      console.log('         ^ Chat is REFUSING impersonated user auth. This is the answer');
      console.log('           that changes the product: the SA must be a registered Chat app.');
    }
  }
}

// ---- 6 read messages -------------------------------------------------------------------
if (firstSpace && both.ok) {
  const res = await fetch(
    `https://chat.googleapis.com/v1/${firstSpace}/messages?pageSize=3`,
    { headers: { Authorization: `Bearer ${both.token}` } },
  );
  const body = await res.text();
  if (res.ok) {
    const j = JSON.parse(body) as { messages?: Array<{ text?: string }> };
    console.log(`L6 PASS  read ${(j.messages ?? []).length} message(s) from ${firstSpace}`);
  } else {
    console.log(`L6 FAIL  ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

console.log('\n--- VERDICT ---');
if (l3.ok && l4.ok && firstSpace) {
  console.log('DWD WORKS for Chat. The agent can act as a person, like Gmail.');
} else if (l3.ok && l4.ok) {
  console.log('Scopes are granted but no space was read. Either the user has no spaces, or');
  console.log('Chat refuses impersonated user auth — read L5 above, they look different.');
} else if (l2.ok) {
  console.log('DWD works for this SA but NOT for the Chat scopes. Add these EXACT strings in');
  console.log('Workspace admin -> Security -> API controls -> Domain-wide delegation:');
  console.log(`   ${CHAT_SPACES}`);
  console.log(`   ${CHAT_MESSAGES}`);
} else {
  console.log('DWD is not working for this SA at all — L2 failed, so this is not Chat-specific.');
}
process.exit(0);
