/**
 * Diagnostic 2: check topic content in substantive agents for flow references.
 * Run: npx tsx src/_diag_agent_flows2.ts
 */

const MS_TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const MS_CLIENT = '68beff40-49fb-4e36-82fe-317bc839a344';
const MS_SECRET = process.env['MS_CLIENT_SECRET']!;
const DV_URL    = 'https://orga243378d.crm.dynamics.com';

async function getMsToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
    { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: MS_CLIENT, client_secret: MS_SECRET, scope: `${DV_URL}/.default` }) },
  );
  const json = await res.json() as { access_token?: string; error_description?: string };
  if (!json.access_token) throw new Error(json.error_description ?? 'token failed');
  return json.access_token;
}

async function dvGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${DV_URL}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} => ${res.status}: ${(await res.text()).substring(0, 200)}`);
  return res.json();
}

const BOT_IDS: Record<string, string> = {
  'IT Help Desk Agent':          '44ba298c-c12d-f111-88b4-6045bd08b5e6',
  'Dev Help Desk Agent':         '230a0af6-a72e-f111-88b4-6045bd08b5e6',
  'HR AGENT':                    '94609d4b-7d33-f111-88b4-6045bd08b5e6',
  'Investment Account Assistant':'71f4828a-535f-f111-a826-6045bd08b5e6',
};

async function main() {
  const token = await getMsToken();
  console.log('Token OK\n');

  for (const [botName, botId] of Object.entries(BOT_IDS)) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`BOT: ${botName}`);
    console.log('='.repeat(50));

    const comps = await dvGet(
      token,
      `botcomponents?$filter=_parentbotid_value eq ${botId}&$select=botcomponentid,name,componenttype&$top=100`,
    ) as { value: Array<{ botcomponentid: string; name: string; componenttype: number }> };

    const topics = comps.value.filter(c => c.componenttype === 9);
    console.log(`${topics.length} topics:`);

    for (const t of topics) {
      const full = await dvGet(
        token,
        `botcomponents(${t.botcomponentid})?$select=name,content,data`,
      ) as { name: string; content?: string; data?: string };

      // content is empty; flow refs are in the `data` field (YAML)
      const cs = full.data ?? full.content ?? '';
      const hasFlow = /InvokeFlow|RunFlow|flowId|workflowId|kind: Flow|kind: RunFlowAction/i.test(cs);

      if (hasFlow) {
        console.log(`\n  *** FLOW TOPIC: "${t.name}" ***`);
        const guids = cs.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
        console.log(`  GUIDs in data: ${guids.slice(0, 8).join(', ')}`);
        const lines = cs.split('\n');
        for (const line of lines) {
          if (/InvokeFlow|RunFlow|flowId|workflowId|kind: Flow/i.test(line)) {
            console.log(`  > ${line.substring(0, 200)}`);
          }
        }
        console.log(`  Preview:\n${cs.substring(0, 800)}\n`);
      } else {
        process.stdout.write(`  ${t.name}: no flow refs\n`);
      }
    }
  }

  console.log('\n=== DONE ===');
}

main().catch(console.error);
export {};
