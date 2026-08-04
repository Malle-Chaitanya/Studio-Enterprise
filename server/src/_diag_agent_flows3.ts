/**
 * Check all fields on a botcomponent topic to find where flow refs live.
 * Run: npx tsx src/_diag_agent_flows3.ts
 */
const MS_TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const MS_CLIENT = '68beff40-49fb-4e36-82fe-317bc839a344';
const DV_URL    = 'https://orga243378d.crm.dynamics.com';

async function getMsToken(): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: MS_CLIENT, client_secret: process.env['MS_CLIENT_SECRET']!, scope: `${DV_URL}/.default` }),
  });
  const j = await res.json() as { access_token?: string; error_description?: string };
  if (!j.access_token) throw new Error(j.error_description ?? 'token failed');
  return j.access_token;
}

async function dvGet(token: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${DV_URL}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).substring(0, 200)}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function main() {
  const token = await getMsToken();
  console.log('Token OK');

  // Dev Help Desk Agent has an unusual topic: 'SharePoint - Send an HTTP request to SharePoint'
  const devBotId = '230a0af6-a72e-f111-88b4-6045bd08b5e6';
  const comps = await dvGet(token, `botcomponents?$filter=_parentbotid_value eq ${devBotId}&$select=botcomponentid,name,componenttype&$top=100`);
  const topics = (comps['value'] as Array<{botcomponentid: string; name: string; componenttype: number}>);
  console.log(`\nDev Help Desk topics (${topics.length}):`);

  for (const t of topics) {
    console.log(`  type=${t.componenttype} "${t.name}" id=${t.botcomponentid}`);
  }

  // Get all fields on the SharePoint topic
  const spTopic = topics.find(t => t.name?.includes('SharePoint'));
  if (spTopic) {
    console.log('\n=== Full fields on SharePoint topic ===');
    const full = await dvGet(token, `botcomponents(${spTopic.botcomponentid})`);
    for (const [k, v] of Object.entries(full)) {
      if (k.startsWith('@')) continue;
      const sv = String(v ?? '');
      if (sv.length > 3) console.log(`  ${k}: ${sv.substring(0, 150)}`);
    }
  }

  // Get all fields on a regular topic too
  const greetTopic = topics.find(t => t.name === 'Greeting');
  if (greetTopic) {
    console.log('\n=== Full fields on Greeting topic ===');
    const full = await dvGet(token, `botcomponents(${greetTopic.botcomponentid})`);
    for (const [k, v] of Object.entries(full)) {
      if (k.startsWith('@')) continue;
      const sv = String(v ?? '');
      if (sv.length > 3) console.log(`  ${k}: ${sv.substring(0, 150)}`);
    }
  }

  // Also check if there are botcomponents of OTHER types we're missing
  console.log('\n=== All component types in Dev Help Desk ===');
  const allComps = await dvGet(token, `botcomponents?$filter=_parentbotid_value eq ${devBotId}&$select=botcomponentid,name,componenttype&$top=100`);
  const byType: Record<number, string[]> = {};
  for (const c of (allComps['value'] as Array<{componenttype: number; name: string}>) ) {
    byType[c.componenttype] = byType[c.componenttype] ?? [];
    byType[c.componenttype].push(c.name);
  }
  for (const [type, names] of Object.entries(byType)) {
    console.log(`  type ${type}: ${names.join(', ')}`);
  }
}

main().catch(console.error);
export {};
