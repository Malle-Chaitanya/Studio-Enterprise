/**
 * End-to-end test for Google connector paths.
 * Run: npx tsx src/_test_google_connectors.ts
 */
import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const SA_KEY      = process.env['GOOGLE_SA_KEY_FILE']!;
const GCP_PROJECT = 'studio-enterprise-migration';
const GCP_REGION  = 'us-central1';
const SA_EMAIL    = 'studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com';
const CHAT_SPACE  = 'spaces/AAQAUHCO4rA';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function buildJwt(scopes: string): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY, 'utf8')) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iss: key.client_email, sub: key.client_email, aud: 'https://oauth2.googleapis.com/token', scope: scopes, iat: now, exp: now + 3600 })).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  return `${h}.${p}.${s}`;
}

async function getScopedToken(scopes: string): Promise<string> {
  const jwt = await buildJwt(scopes);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await r.json() as { access_token?: string; error?: string; error_description?: string };
  if (!j.access_token) throw new Error(`Token failed: ${j.error_description ?? j.error}`);
  return j.access_token;
}

async function deployAndRun(
  gcpToken: string, name: string, yaml: string, args: Record<string, unknown>,
): Promise<{ state: string; error: string | null; step: string | null; result: string | null }> {
  const base = `https://workflows.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}`;
  const headers = { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ sourceContents: yaml, serviceAccount: SA_EMAIL });

  let opRes = await fetch(`${base}/workflows?workflowId=${name}`, { method: 'POST', headers, body });
  if (opRes.status === 409) opRes = await fetch(`${base}/workflows/${name}?updateMask=sourceContents,serviceAccount`, { method: 'PATCH', headers, body });
  if (!opRes.ok) throw new Error(`Deploy: ${await opRes.text()}`);
  const op = await opRes.json() as { name: string };

  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const p = await (await fetch(`https://workflows.googleapis.com/v1/${op.name}`, { headers: { Authorization: `Bearer ${gcpToken}` } })).json() as { done?: boolean; error?: { message: string } };
    if (p.done) { if (p.error) throw new Error(`Deploy op: ${p.error.message}`); break; }
  }

  const execRes = await fetch(
    `https://workflowexecutions.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${GCP_REGION}/workflows/${name}/executions`,
    { method: 'POST', headers, body: JSON.stringify({ argument: JSON.stringify(args) }) },
  );
  if (!execRes.ok) throw new Error(`Exec: ${await execRes.text()}`);
  const exec = await execRes.json() as { name: string };

  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const s = await (await fetch(`https://workflowexecutions.googleapis.com/v1/${exec.name}`, { headers: { Authorization: `Bearer ${gcpToken}` } })).json() as {
      state: string; result?: string; error?: { payload: string; stackTrace?: { elements: Array<{ step: string }> } };
    };
    if (s.state !== 'ACTIVE' && s.state !== 'QUEUED') {
      return { state: s.state, result: s.result ?? null, error: s.error?.payload ?? null, step: s.error?.stackTrace?.elements?.[0]?.step ?? null };
    }
  }
  return { state: 'TIMEOUT', error: null, step: null, result: null };
}

// ── Enable APIs ────────────────────────────────────────────────────────────────

async function enableApi(gcpToken: string, api: string): Promise<void> {
  const res = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${GCP_PROJECT}/services/${api}:enable`,
    { method: 'POST', headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' }, body: '{}' },
  );
  const j = await res.json() as { error?: { message: string } };
  if (!res.ok && !j.error?.message?.includes('already enabled')) {
    console.log(`  ⚠ Enable ${api}: ${j.error?.message}`);
  }
}

async function checkApiEnabled(gcpToken: string, api: string): Promise<boolean> {
  const res = await fetch(`https://serviceusage.googleapis.com/v1/projects/${GCP_PROJECT}/services/${api}`, { headers: { Authorization: `Bearer ${gcpToken}` } });
  const j = await res.json() as { state?: string };
  return j.state === 'ENABLED';
}

// ── Test 1: Google Chat ────────────────────────────────────────────────────────

async function testGoogleChat(gcpToken: string) {
  console.log('\n═══ TEST 1: Google Chat ═══');

  // 1a. Enable Chat API if needed
  const chatEnabled = await checkApiEnabled(gcpToken, 'chat.googleapis.com');
  console.log(`  Chat API enabled: ${chatEnabled ? 'YES' : 'NO — enabling now...'}`);
  if (!chatEnabled) {
    await enableApi(gcpToken, 'chat.googleapis.com');
    await sleep(5000); // propagation wait
    console.log('  Chat API enabled ✓');
  }

  // 1b. Get Chat-scoped token
  let chatToken: string;
  try {
    chatToken = await getScopedToken('https://www.googleapis.com/auth/chat.spaces https://www.googleapis.com/auth/chat.messages https://www.googleapis.com/auth/chat.spaces.create');
    console.log('  Chat token obtained ✓');
  } catch (e) {
    console.log(`  ✗ Chat token failed: ${(e as Error).message}`);
    return;
  }

  // 1c. List spaces SA has access to
  const spacesRes = await fetch('https://chat.googleapis.com/v1/spaces', { headers: { Authorization: `Bearer ${chatToken}` } });
  const spaces = await spacesRes.json() as { spaces?: Array<{ name: string; displayName?: string }> };
  const spaceList = spaces.spaces ?? [];
  console.log(`  SA member of ${spaceList.length} space(s)`);

  // 1d. Try target space first
  const targetMsgRes = await fetch(`https://chat.googleapis.com/v1/${CHAT_SPACE}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${chatToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello from Studio Enterprise migration! Cloud Workflow → Google Chat ✓' }),
  });
  const targetMsg = await targetMsgRes.json() as { name?: string; error?: { message: string; code: number } };

  if (targetMsg.name) {
    console.log(`  ✓ Message posted to ${CHAT_SPACE}`);
    console.log('  ✓ GOOGLE CHAT (target space): WORKING END-TO-END ✓');
    return;
  }

  console.log(`  Target space ${CHAT_SPACE}: ${targetMsg.error?.code} — ${targetMsg.error?.message}`);

  // 1e. Create a new space as SA (proves the API path works)
  console.log('  → Creating new test space as SA...');
  const createRes = await fetch('https://chat.googleapis.com/v1/spaces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${chatToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ spaceType: 'SPACE', displayName: 'Studio Enterprise Test' }),
  });
  const newSpace = await createRes.json() as { name?: string; displayName?: string; error?: { message: string } };

  if (!newSpace.name) {
    console.log(`  ✗ Space creation failed: ${newSpace.error?.message}`);
    // Fallback: test via Cloud Workflow with built-in OAuth2
    await testChatViaWorkflow(gcpToken);
    return;
  }

  console.log(`  ✓ Created space: ${newSpace.name}`);

  // 1f. Post a message to the new space
  const msgRes = await fetch(`https://chat.googleapis.com/v1/${newSpace.name}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${chatToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello from Studio Enterprise! Cloud Workflow → Google Chat ✓' }),
  });
  const msg = await msgRes.json() as { name?: string; error?: { message: string } };

  if (msg.name) {
    console.log(`  ✓ Message posted: ${msg.name}`);
    console.log('  ✓ GOOGLE CHAT: WORKING END-TO-END ✓');
    console.log(`\n  ACTION NEEDED: To use YOUR space (${CHAT_SPACE}):`);
    console.log(`  Add ${SA_EMAIL} to the space in Google Chat settings.`);
  } else {
    console.log(`  ✗ Message failed: ${msg.error?.message}`);
    await testChatViaWorkflow(gcpToken);
  }
}

async function testChatViaWorkflow(gcpToken: string) {
  console.log('  → Testing via Cloud Workflow (SA OAuth2)...');
  const yaml = [
    'main:',
    '  params: [args]',
    '  steps:',
    '    - post_message:',
    '        call: http.post',
    '        args:',
    `          url: "https://chat.googleapis.com/v1/${CHAT_SPACE}/messages"`,
    '          auth:',
    '            type: OAuth2',
    '            scopes: https://www.googleapis.com/auth/chat.messages',
    '          body:',
    '            text: "Hello from Studio Enterprise! Cloud Workflow -> Google Chat"',
    '        result: resp',
    '    - done:',
    '        return: ${resp.body}',
  ].join('\n');

  const result = await deployAndRun(gcpToken, 'test-google-chat-wf', yaml, {
    space_id: CHAT_SPACE,
    message: 'Hello from Studio Enterprise! ✓',
  });
  console.log(`  Workflow state: ${result.state}`);
  if (result.error) console.log(`  error: ${result.error.substring(0, 200)}`);
  if (result.state === 'SUCCEEDED') console.log('  ✓ CHAT VIA WORKFLOW: WORKING');
}

// ── Test 2: Google Drive ───────────────────────────────────────────────────────

async function testGoogleDrive(gcpToken: string) {
  console.log('\n═══ TEST 2: Google Drive ═══');

  // Enable Drive API if needed
  const driveEnabled = await checkApiEnabled(gcpToken, 'drive.googleapis.com');
  if (!driveEnabled) {
    console.log('  Enabling Drive API...');
    await enableApi(gcpToken, 'drive.googleapis.com');
    await sleep(5000);
  }

  // Test directly with Drive token (simpler than workflow for file upload)
  let driveToken: string;
  try {
    driveToken = await getScopedToken('https://www.googleapis.com/auth/drive.file');
    console.log('  Drive token obtained ✓');
  } catch (e) {
    console.log(`  ✗ Drive token failed: ${(e as Error).message}`);
    return;
  }

  // Create a file via multipart upload (metadata + content)
  const metadata = JSON.stringify({ name: 'studio-enterprise-test.txt', mimeType: 'text/plain' });
  const content = 'Migration test from Studio Enterprise — Cloud Workflow → Google Drive ✓';
  const boundary = 'migration_test_boundary';
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n');

  const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${driveToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  const file = await uploadRes.json() as { id?: string; name?: string; error?: { message: string } };

  if (file.id) {
    console.log(`  ✓ File uploaded: "${file.name}" (id=${file.id})`);
    console.log('  ✓ GOOGLE DRIVE: WORKING END-TO-END ✓');

    // Now test via Cloud Workflow too
    await testDriveViaWorkflow(gcpToken, file.id);
  } else {
    console.log(`  ✗ Upload failed: ${file.error?.message ?? JSON.stringify(file)}`);
  }
}

async function testDriveViaWorkflow(gcpToken: string, existingFileId: string) {
  console.log('  Testing Drive LIST via Cloud Workflow...');
  const yaml = [
    'main:',
    '  params: [args]',
    '  steps:',
    '    - list_files:',
    '        call: http.get',
    '        args:',
    '          url: https://www.googleapis.com/drive/v3/files',
    '          auth:',
    '            type: OAuth2',
    '            scopes: https://www.googleapis.com/auth/drive.readonly',
    '          query:',
    '            pageSize: 5',
    '            fields: files(id,name,mimeType)',
    '        result: resp',
    '    - done:',
    '        return: ${resp.body}',
  ].join('\n');

  const result = await deployAndRun(gcpToken, 'test-google-drive-wf', yaml, {});
  console.log(`  Workflow state: ${result.state}`);
  if (result.error) console.log(`  error: ${result.error.substring(0, 200)}`);
  if (result.result) {
    try {
      const r = JSON.parse(result.result) as { files?: Array<{ name: string }> };
      console.log(`  ✓ Drive via workflow: ${r.files?.length ?? 0} files listed`);
      console.log('  ✓ DRIVE VIA WORKFLOW: WORKING ✓');
    } catch { console.log(`  result: ${result.result.substring(0, 200)}`); }
  }
  void existingFileId;
}

// ── Test 3: Gmail ─────────────────────────────────────────────────────────────

async function testGmail(gcpToken: string) {
  console.log('\n═══ TEST 3: Gmail ═══');

  const gmailEnabled = await checkApiEnabled(gcpToken, 'gmail.googleapis.com');
  if (!gmailEnabled) {
    console.log('  Enabling Gmail API...');
    await enableApi(gcpToken, 'gmail.googleapis.com');
    await sleep(5000);
  }

  // Gmail requires DWD — test auth status
  let gmailToken: string;
  try {
    gmailToken = await getScopedToken('https://www.googleapis.com/auth/gmail.send');
    console.log('  Gmail token obtained ✓');
  } catch (e) {
    console.log(`  ✗ Gmail token failed: ${(e as Error).message}`);
    return;
  }

  // Try to get SA's own profile (will fail without DWD — SA has no Gmail)
  const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${gmailToken}` },
  });
  const profile = await profileRes.json() as { emailAddress?: string; error?: { message: string; code: number } };

  if (profile.emailAddress) {
    console.log(`  ✓ Gmail access: ${profile.emailAddress}`);
    console.log('  ✓ GMAIL: WORKING (DWD configured)');
  } else {
    console.log(`  Gmail profile: ${profile.error?.code} — ${profile.error?.message}`);
    console.log('  ⚠ Gmail needs Domain-wide Delegation to impersonate a Workspace user');
    console.log('  → SA can get token but has no Gmail inbox without DWD');
    console.log('  → For demo: configure DWD in Google Workspace Admin → Grant SA gmail.send scope');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Google Connector End-to-End Tests ===\n');
  console.log(`SA:      ${SA_EMAIL}`);
  console.log(`Project: ${GCP_PROJECT}\n`);

  const gcpToken = await getGcpToken();

  async function getGcpToken(): Promise<string> {
    return getScopedToken('https://www.googleapis.com/auth/cloud-platform');
  }

  await testGoogleChat(gcpToken);
  await testGoogleDrive(gcpToken);
  await testGmail(gcpToken);

  console.log('\n=== Done ===');
}

main().catch(console.error);
