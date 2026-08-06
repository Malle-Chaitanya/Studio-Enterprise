/**
 * Call the Confluence_agent via Direct Line API and parse the spaces from its response.
 *
 * Flow:
 *  1. Get Direct Line token using the session's dvDelegatedToken (user identity)
 *  2. Start a Direct Line conversation
 *  3. Send "list all confluence spaces with space keys"
 *  4. Poll for the agent's response
 *  5. Print the full response + extract space keys/names
 *
 * Usage: cd server && npx tsx src/spikes/_diag_directline_spaces.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { delegatedDataverseToken, clientCredsToken, graphTokenFromRefresh } from '../auth/microsoft.js';

const ORG_URL    = 'https://orga243378d.crm.dynamics.com';
const BOT_SCHEMA = 'crf37_Confluenceagent';
const QUERY      = 'List all the Confluence spaces you have access to with their space keys and space names';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 20; // 40 seconds max

async function main() {
  await connectMongo();
  const s = (await getDb()
    .collection('migrationSessions')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next()) as Session | null;
  if (!s) throw new Error('No session — log in first.');

  // The Confluence_agent lives at ORG_URL (orga243378d), not necessarily s.dvOrgUrl.
  // We MUST scope the delegated token to the bot's org URL, not the session's dvOrgUrl.
  const botOrgUrl = ORG_URL;

  type TokenCandidate = { tok: string; kind: string };
  const candidates: TokenCandidate[] = [];

  if (s.tenantId && s.refreshToken) {
    const gTok = await graphTokenFromRefresh(s.tenantId, s.refreshToken);
    if (gTok) candidates.push({ tok: gTok, kind: 'Graph delegated (refresh)' });

    // Scope delegated token to the BOT's org, not the session's dvOrgUrl
    const dvDel = await delegatedDataverseToken(s.tenantId, s.refreshToken, botOrgUrl);
    if (dvDel) candidates.push({ tok: dvDel.token, kind: `Dataverse delegated for ${botOrgUrl}` });
  }
  if (s.dvDelegatedToken) candidates.push({ tok: s.dvDelegatedToken, kind: 'dvDelegatedToken (stored)' });

  // App-only for the bot's org as last resort
  const appOnlyTok = s.tenantId ? await clientCredsToken(s.tenantId, botOrgUrl).catch(() => '') : (s.dvToken ?? '');
  if (appOnlyTok) candidates.push({ tok: appOnlyTok, kind: 'app-only client credentials' });

  console.log(`Candidates: ${candidates.map((c) => c.kind).join(', ')}`);
  console.log(`User: ${s.msEmail ?? '(unknown)'}`);

  // Try additional scopes for the PVA gateway endpoint
  const BOT_ID = 'cd560e08-8e90-f111-8077-0022480a981d';
  // These scopes might require admin consent — try each as both client creds and delegated
  const extraScopes = [
    'https://api.powerapps.com',   // PowerApps Service — newly granted User delegated permission
    'https://service.powerapps.com',
    'https://api.powerplatform.com',
  ];
  for (const scope of extraScopes) {
    if (s.tenantId) {
      // Try client credentials
      try {
        const tok = await clientCredsToken(s.tenantId, scope);
        candidates.push({ tok, kind: `${scope} (client creds)` });
      } catch { /* ignore */ }
      // Also try delegated via refresh token exchange for the same scope
      if (s.refreshToken) {
        try {
          const t = await (async () => {
            const d = await import('../config.js');
            const body = new URLSearchParams({
              client_id: d.config.MS_CLIENT_ID,
              client_secret: d.config.MS_CLIENT_SECRET,
              grant_type: 'refresh_token',
              refresh_token: s.refreshToken!,
              scope: `${scope}/.default offline_access`,
            });
            const res = await fetch(`https://login.microsoftonline.com/${s.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
            if (!res.ok) return null;
            const j = (await res.json()) as { access_token?: string };
            return j.access_token ?? null;
          })();
          if (t) candidates.push({ tok: t, kind: `${scope} (delegated refresh)` });
        } catch { /* ignore */ }
      }
    }
  }
  console.log(`Updated candidates: ${candidates.map((c) => c.kind).join(', ')}`);

  // Decode and log the Dataverse delegated token audience for diagnostics
  const dvDelCand = candidates.find((c) => c.kind.includes('Dataverse'));
  if (dvDelCand) {
    try {
      const parts = dvDelCand.tok.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
      console.log(`Dataverse delegated token aud: ${payload.aud}, upn: ${payload.upn ?? payload.preferred_username}, exp: ${new Date((payload.exp as number) * 1000).toISOString()}`);
    } catch { /* ignore */ }
  }

  // ── Step 1: Get Direct Line token ─────────────────────────────────────────
  console.log('\n[1] Getting Direct Line token...');
  // Discover the Power Platform environment URL from BAP
  let ppEnvBaseUrl = '';
  try {
    const bapToken = await clientCredsToken(s.tenantId ?? '', 'https://api.bap.microsoft.com');
    const bapRes = await fetch(
      'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01',
      { headers: { Authorization: `Bearer ${bapToken}` } },
    );
    if (bapRes.ok) {
      const bapJson = (await bapRes.json()) as {
        value?: {
          name?: string;
          properties?: {
            displayName?: string;
            linkedEnvironmentMetadata?: { instanceUrl?: string; uniqueName?: string; domainName?: string };
            runtimeEndpoints?: Record<string, string>;
          };
        }[];
      };
      console.log('\nBAP environments:');
      for (const env of bapJson.value ?? []) {
        const instanceUrl = (env.properties?.linkedEnvironmentMetadata?.instanceUrl ?? '').replace(/\/$/, '');
        const envName = env.name ?? '';
        const displayName = env.properties?.displayName ?? '';
        const runtimeEndpoints = env.properties?.runtimeEndpoints ?? {};
        const domainName = env.properties?.linkedEnvironmentMetadata?.domainName ?? '';
        console.log(`  ${displayName} | name=${envName} | instanceUrl=${instanceUrl} | domain=${domainName}`);
        if (Object.keys(runtimeEndpoints).length) console.log(`    runtimeEndpoints:`, JSON.stringify(runtimeEndpoints));
        if (instanceUrl === botOrgUrl) {
          // Try to build the PP env URL from the environment name (GUID)
          if (envName) {
            ppEnvBaseUrl = `https://${envName.toLowerCase()}.environment.api.powerplatform.com`;
            console.log(`  → Matched! PP env URL: ${ppEnvBaseUrl}`);
          }
          // Also check runtimeEndpoints for a more authoritative URL
          const pvaCmUrl = runtimeEndpoints['microsoft.PowerVirtualAgents'] ?? '';
          if (pvaCmUrl) {
            ppEnvBaseUrl = pvaCmUrl.replace(/\/$/, '');
            console.log(`  → PVA runtime endpoint: ${ppEnvBaseUrl}`);
          }
        }
      }
    }
  } catch (e) {
    console.log(`BAP lookup failed: ${(e as Error).message}`);
  }

  // Build URL list: gateway (where the API actually lives) + PP environment URL
  const dlTokenUrls: string[] = [];
  if (ppEnvBaseUrl) {
    dlTokenUrls.push(
      `${ppEnvBaseUrl}/powervirtualagents/botsbyschema/${BOT_SCHEMA}/directline/token?api-version=2022-03-01-preview`,
      `${ppEnvBaseUrl}/powervirtualagents/bots/${BOT_ID}/directline/token?api-version=2022-03-01-preview`,
    );
    // Also try the discovered environment URL (GUID-based)
    const envApiUrl = 'https://default-807d6772-847c-40e2-9bec-e2c930b3a42e.environment.api.powerplatform.com';
    dlTokenUrls.push(
      `${envApiUrl}/powervirtualagents/botsbyschema/${BOT_SCHEMA}/directline/token?api-version=2022-03-01-preview`,
    );
  }
  // CRM org fallback
  dlTokenUrls.push(
    `${botOrgUrl}/powervirtualagents/botsbyschema/${BOT_SCHEMA}/directline/token?api-version=2022-03-01-preview`,
  );

  function decodeAud(tok: string): string {
    try { return (JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()) as Record<string,unknown>).aud as string ?? ''; } catch { return '?'; }
  }

  async function tryDLToken(tok: string, kind: string, targetUrl: string): Promise<{ token: string; body: string } | null> {
    const aud = await decodeAud(tok);
    console.log(`    Trying with ${kind} (aud:${aud}) → ${targetUrl.slice(targetUrl.indexOf('/powervirtual'))}`);
    const res = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
    });
    const body = await res.text();
    console.log(`    Status: ${res.status}, content starts: ${body.slice(0, 80).replace(/\s+/g, ' ')}`);
    if (!res.ok) {
      console.log('    Error body:', body.slice(0, 300));
      return null;
    }
    try {
      const parsed = JSON.parse(body) as { token?: string };
      return { token: parsed.token ?? '', body };
    } catch {
      console.log('    200 but response is not JSON (HTML redirect) — skipping.');
      return { token: '', body };
    }
  }

  let dlTokenResult: { token: string; body: string } | null = null;
  outer: for (const dlUrl of dlTokenUrls) {
    for (const c of candidates) {
      const r = await tryDLToken(c.tok, c.kind, dlUrl);
      if (r?.token) { dlTokenResult = r; break outer; }
      if (r && !r.token) continue; // HTML — try next
    }
  }
  if (!dlTokenResult) throw new Error('Direct Line token request failed with all token candidates.');
  console.log('    Full DL response:', dlTokenResult.body.slice(0, 500));
  const dlTokenJson = JSON.parse(dlTokenResult.body) as { token?: string; conversationId?: string };
  console.log('    Parsed:', JSON.stringify(dlTokenJson, null, 2));

  const dlToken = dlTokenJson.token ?? dlTokenResult.token;
  if (!dlToken) throw new Error('No token in Direct Line token response');

  // ── Step 2: Start a Direct Line conversation ───────────────────────────────
  console.log('\n[2] Starting Direct Line conversation...');
  const startConvRes = await fetch('https://directline.botframework.com/v3/directline/conversations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${dlToken}`, Accept: 'application/json' },
  });
  const startConvBody = await startConvRes.text();
  console.log(`    Status: ${startConvRes.status}`);
  if (!startConvRes.ok) {
    console.log('    Error:', startConvBody.slice(0, 500));
    throw new Error(`Start conversation failed: ${startConvRes.status}`);
  }
  const conv = JSON.parse(startConvBody) as { conversationId?: string; token?: string };
  const conversationId = conv.conversationId;
  console.log('    ConversationId:', conversationId);
  if (!conversationId) throw new Error('No conversationId in response');

  // ── Step 3: Send the query ─────────────────────────────────────────────────
  console.log(`\n[3] Sending query: "${QUERY}"`);
  const sendRes = await fetch(
    `https://directline.botframework.com/v3/directline/conversations/${conversationId}/activities`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${dlToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        type: 'message',
        from: { id: 'csge-backend', name: 'CSGE Migration Tool' },
        text: QUERY,
      }),
    },
  );
  const sendBody = await sendRes.text();
  console.log(`    Status: ${sendRes.status}`);
  if (!sendRes.ok) {
    console.log('    Error:', sendBody.slice(0, 500));
    throw new Error(`Send message failed: ${sendRes.status}`);
  }
  console.log('    Message sent:', sendBody.slice(0, 200));

  // ── Step 4: Poll for response ─────────────────────────────────────────────
  console.log(`\n[4] Polling for response (up to ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s)...`);
  let watermark = '';
  let agentResponse = '';
  let found = false;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const pollUrl = `https://directline.botframework.com/v3/directline/conversations/${conversationId}/activities` +
      (watermark ? `?watermark=${watermark}` : '');
    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${dlToken}`, Accept: 'application/json' },
    });
    if (!pollRes.ok) {
      console.log(`    Poll attempt ${attempt + 1}: ${pollRes.status}`);
      continue;
    }
    const pollJson = JSON.parse(await pollRes.text()) as {
      activities?: Array<{
        type?: string;
        from?: { role?: string; id?: string };
        text?: string;
        speak?: string;
        attachments?: unknown[];
        entities?: unknown[];
        channelData?: unknown;
      }>;
      watermark?: string;
    };

    watermark = pollJson.watermark ?? watermark;
    const botMessages = (pollJson.activities ?? []).filter(
      (a) => a.type === 'message' && (a.from?.role === 'bot' || a.from?.id === 'bot'),
    );

    if (botMessages.length > 0) {
      console.log(`\n    Got ${botMessages.length} bot message(s):`);
      for (const msg of botMessages) {
        const text = msg.text ?? msg.speak ?? '(no text)';
        agentResponse += text + '\n';
        console.log('\n    ── Bot message ──');
        console.log(text);
        if (msg.attachments) {
          console.log('\n    Attachments:', JSON.stringify(msg.attachments, null, 2).slice(0, 1000));
        }
        if (msg.entities) {
          console.log('\n    Entities:', JSON.stringify(msg.entities, null, 2).slice(0, 1000));
        }
        if (msg.channelData) {
          console.log('\n    ChannelData:', JSON.stringify(msg.channelData, null, 2).slice(0, 1000));
        }
      }
      found = true;

      // Wait one more poll cycle for any follow-up messages
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const poll2 = await fetch(
        `https://directline.botframework.com/v3/directline/conversations/${conversationId}/activities?watermark=${watermark}`,
        { headers: { Authorization: `Bearer ${dlToken}`, Accept: 'application/json' } },
      );
      if (poll2.ok) {
        const p2 = JSON.parse(await poll2.text()) as { activities?: Array<{ type?: string; from?: { role?: string; id?: string }; text?: string }> };
        const more = (p2.activities ?? []).filter((a) => a.type === 'message' && (a.from?.role === 'bot' || a.from?.id === 'bot'));
        for (const m of more) { if (m.text) { agentResponse += m.text + '\n'; console.log('\n    ── Follow-up ──\n', m.text); } }
      }
      break;
    }
    process.stdout.write(`    Attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS} — waiting...\r`);
  }

  if (!found) {
    console.log('\n    Timeout: no bot response received.');
    process.exit(1);
  }

  // ── Step 5: Parse space keys/names ────────────────────────────────────────
  console.log('\n\n[5] Parsing space keys and names from response...');
  // Look for table rows: | key | name | or "ENG - Engineering" style lines
  const tableRowRe = /\|\s*([A-Z][A-Z0-9~]+)\s*\|\s*([^|]+?)\s*\|/g;
  const inlineRe   = /\b([A-Z][A-Z0-9]{1,15})\b\s*[-–:]\s*([A-Za-z][^,\n\|]{3,50})/g;
  const urlRe      = /\/wiki\/spaces\/([A-Z][A-Z0-9~]+)\//g;

  const spaces: Array<{ key: string; name: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = tableRowRe.exec(agentResponse)) !== null) {
    spaces.push({ key: m[1].trim(), name: m[2].trim() });
  }
  if (spaces.length === 0) {
    while ((m = inlineRe.exec(agentResponse)) !== null) {
      spaces.push({ key: m[1].trim(), name: m[2].trim() });
    }
  }
  // Also extract space keys from URLs
  const urlKeys: string[] = [];
  while ((m = urlRe.exec(agentResponse)) !== null) {
    if (!urlKeys.includes(m[1])) urlKeys.push(m[1]);
  }

  if (spaces.length > 0) {
    console.log('\nExtracted spaces:');
    spaces.forEach((sp, i) => console.log(`  ${i + 1}. key="${sp.key}"  name="${sp.name}"`));
  } else {
    console.log('  No structured space data extracted — check raw response above.');
  }
  if (urlKeys.length > 0) {
    console.log('\nSpace keys from URLs:', urlKeys);
  }

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
