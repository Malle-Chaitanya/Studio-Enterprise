/**
 * Live-test the "Migrate Advisor" agent via Direct Line to see whether its
 * "Custom prompt 8/3/2026, 12:09:00 PM" tool (InvokeAIBuilderModelTaskAction,
 * instruction "Answer the question user asked / with a 2 sentence
 * summarization") actually fires on a real question.
 *
 * Adapted from _diag_directline_spaces.ts (same auth/token pattern), pointed
 * at Migrate Advisor's own org/bot instead of Confluence_agent.
 *
 * Usage: cd server && npx tsx src/spikes/_diag_test_migrate_advisor_prompt.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { delegatedDataverseToken, clientCredsToken, graphTokenFromRefresh } from '../auth/microsoft.js';

const ORG_URL    = 'https://org32322095.crm.dynamics.com';
const BOT_SCHEMA = 'cr88d_EnterpriseMigrationKnowledge';
const BOT_ID     = 'bdf9b817-9b90-f111-b8da-0022480b1f83';
const QUERY      = process.argv[2] ?? 'What are the prerequisites for migrating Google Drive content to SharePoint?';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 20;

async function main() {
  await connectMongo();
  const s = (await getDb()
    .collection('migrationSessions')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next()) as Session | null;
  if (!s) throw new Error('No session — log in first.');

  const botOrgUrl = ORG_URL;

  type TokenCandidate = { tok: string; kind: string };
  const candidates: TokenCandidate[] = [];

  if (s.tenantId && s.refreshToken) {
    const gTok = await graphTokenFromRefresh(s.tenantId, s.refreshToken);
    if (gTok) candidates.push({ tok: gTok, kind: 'Graph delegated (refresh)' });
    const dvDel = await delegatedDataverseToken(s.tenantId, s.refreshToken, botOrgUrl);
    if (dvDel) candidates.push({ tok: dvDel.token, kind: `Dataverse delegated for ${botOrgUrl}` });
  }
  if (s.dvDelegatedToken) candidates.push({ tok: s.dvDelegatedToken, kind: 'dvDelegatedToken (stored)' });
  const appOnlyTok = s.tenantId ? await clientCredsToken(s.tenantId, botOrgUrl).catch(() => '') : (s.dvToken ?? '');
  if (appOnlyTok) candidates.push({ tok: appOnlyTok, kind: 'app-only client credentials' });

  console.log(`Candidates: ${candidates.map((c) => c.kind).join(', ')}`);
  console.log(`User: ${s.msEmail ?? '(unknown)'}`);

  // Discover the PVA runtime endpoint for this org via BAP
  console.log('\n[1] Discovering PVA runtime endpoint...');
  let ppEnvBaseUrl = '';
  try {
    const bapToken = await clientCredsToken(s.tenantId ?? '', 'https://api.bap.microsoft.com');
    const bapRes = await fetch(
      'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2020-10-01',
      { headers: { Authorization: `Bearer ${bapToken}` } },
    );
    if (bapRes.ok) {
      const bapJson = (await bapRes.json()) as {
        value?: { name?: string; properties?: { linkedEnvironmentMetadata?: { instanceUrl?: string }; runtimeEndpoints?: Record<string, string> } }[];
      };
      for (const env of bapJson.value ?? []) {
        const instanceUrl = (env.properties?.linkedEnvironmentMetadata?.instanceUrl ?? '').replace(/\/$/, '');
        if (instanceUrl === botOrgUrl) {
          const pvaCmUrl = env.properties?.runtimeEndpoints?.['microsoft.PowerVirtualAgents'] ?? '';
          if (pvaCmUrl) { ppEnvBaseUrl = pvaCmUrl.replace(/\/$/, ''); console.log(`  → PVA runtime endpoint: ${ppEnvBaseUrl}`); }
          else if (env.name) { ppEnvBaseUrl = `https://${env.name.toLowerCase()}.environment.api.powerplatform.com`; console.log(`  → Built from env name: ${ppEnvBaseUrl}`); }
        }
      }
    }
  } catch (e) { console.log(`BAP lookup failed: ${(e as Error).message}`); }

  const dlTokenUrls: string[] = [];
  if (ppEnvBaseUrl) {
    dlTokenUrls.push(
      `${ppEnvBaseUrl}/powervirtualagents/botsbyschema/${BOT_SCHEMA}/directline/token?api-version=2022-03-01-preview`,
      `${ppEnvBaseUrl}/powervirtualagents/bots/${BOT_ID}/directline/token?api-version=2022-03-01-preview`,
    );
  }
  dlTokenUrls.push(`${botOrgUrl}/powervirtualagents/botsbyschema/${BOT_SCHEMA}/directline/token?api-version=2022-03-01-preview`);

  async function tryDLToken(tok: string, kind: string, targetUrl: string): Promise<{ token: string; body: string } | null> {
    console.log(`    Trying with ${kind} → ${targetUrl.slice(targetUrl.indexOf('/powervirtual'))}`);
    const res = await fetch(targetUrl, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } });
    const body = await res.text();
    console.log(`    Status: ${res.status}`);
    if (!res.ok) { console.log('    Error body:', body.slice(0, 300)); return null; }
    try {
      const parsed = JSON.parse(body) as { token?: string };
      return { token: parsed.token ?? '', body };
    } catch { console.log('    200 but not JSON — skipping.'); return null; }
  }

  let dlTokenResult: { token: string; body: string } | null = null;
  outer: for (const dlUrl of dlTokenUrls) {
    for (const c of candidates) {
      const r = await tryDLToken(c.tok, c.kind, dlUrl);
      if (r?.token) { dlTokenResult = r; break outer; }
    }
  }
  if (!dlTokenResult) throw new Error('Direct Line token request failed with all candidates.');
  const dlToken = JSON.parse(dlTokenResult.body).token as string;

  console.log('\n[2] Starting Direct Line conversation...');
  const startConvRes = await fetch('https://directline.botframework.com/v3/directline/conversations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${dlToken}`, Accept: 'application/json' },
  });
  if (!startConvRes.ok) throw new Error(`Start conversation failed: ${startConvRes.status}: ${await startConvRes.text()}`);
  const conv = (await startConvRes.json()) as { conversationId?: string };
  const conversationId = conv.conversationId;
  if (!conversationId) throw new Error('No conversationId in response');
  console.log('    ConversationId:', conversationId);

  console.log(`\n[3] Sending query: "${QUERY}"`);
  const sendRes = await fetch(`https://directline.botframework.com/v3/directline/conversations/${conversationId}/activities`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dlToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ type: 'message', from: { id: 'csge-backend', name: 'CSGE Migration Tool' }, text: QUERY }),
  });
  if (!sendRes.ok) throw new Error(`Send message failed: ${sendRes.status}: ${await sendRes.text()}`);

  console.log(`\n[4] Polling for response (up to ${POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s)...`);
  let watermark = '';
  let found = false;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollUrl = `https://directline.botframework.com/v3/directline/conversations/${conversationId}/activities` + (watermark ? `?watermark=${watermark}` : '');
    const pollRes = await fetch(pollUrl, { headers: { Authorization: `Bearer ${dlToken}`, Accept: 'application/json' } });
    if (!pollRes.ok) continue;
    const pollJson = (await pollRes.json()) as {
      activities?: Array<{ type?: string; from?: { role?: string; id?: string }; text?: string; speak?: string; channelData?: unknown; entities?: unknown[] }>;
      watermark?: string;
    };
    watermark = pollJson.watermark ?? watermark;
    const botMessages = (pollJson.activities ?? []).filter((a) => a.type === 'message' && (a.from?.role === 'bot' || a.from?.id === 'bot'));
    if (botMessages.length > 0) {
      console.log(`\n    Got ${botMessages.length} bot message(s):`);
      for (const msg of botMessages) {
        console.log('\n    ── Bot message ──');
        console.log(msg.text ?? msg.speak ?? '(no text)');
        if (msg.channelData) console.log('\n    ChannelData:', JSON.stringify(msg.channelData, null, 2).slice(0, 2000));
        if (msg.entities) console.log('\n    Entities:', JSON.stringify(msg.entities, null, 2).slice(0, 2000));
      }
      found = true;
      break;
    }
    process.stdout.write(`    Attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS} — waiting...\r`);
  }

  if (!found) { console.log('\n    Timeout: no bot response received.'); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });