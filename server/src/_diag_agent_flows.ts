/**
 * Diagnostic: explore how Copilot Studio agents link to PA flows in Dataverse.
 *
 * Run: npx tsx src/_diag_agent_flows.ts
 */

const MS_TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const MS_CLIENT = '68beff40-49fb-4e36-82fe-317bc839a344';
const MS_SECRET = process.env['MS_CLIENT_SECRET']!;
const DV_URL    = 'https://orga243378d.crm.dynamics.com';

async function getMsToken(scope: string): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: MS_CLIENT,
        client_secret: MS_SECRET,
        scope,
      }),
    },
  );
  const json = await res.json() as { access_token?: string; error_description?: string };
  if (!json.access_token) throw new Error(json.error_description ?? 'token failed');
  return json.access_token;
}

async function dvGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${DV_URL}/api/data/v9.2/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
      Prefer: 'odata.include-annotations="*"',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GET ${path} => ${res.status}: ${t.substring(0, 300)}`);
  }
  return res.json();
}

async function main() {
  const token = await getMsToken(`${DV_URL}/.default`);
  console.log('Token OK\n');

  // 1. List Copilot Studio agents (bots table)
  console.log('=== 1. Copilot Studio Agents (bots) ===');
  const bots = await dvGet(token, 'bots?$select=botid,name,schemaname,statuscode,solutionid&$top=20') as {
    value: Array<{ botid: string; name: string; schemaname: string; statuscode: number; solutionid?: string }>;
  };
  console.log(`Found ${bots.value.length} agents:`);
  for (const b of bots.value) {
    console.log(`  [${b.botid}] ${b.name} (schema=${b.schemaname} status=${b.statuscode})`);
  }

  if (!bots.value.length) {
    console.log('No bots found — checking botcomponents directly...');
  }

  const firstBot = bots.value[0];

  // 2. Bot components (topics, flows, etc) for first agent
  if (firstBot) {
    console.log(`\n=== 2. Bot Components for "${firstBot.name}" (no content, discover fields) ===`);
    // First: list available fields via $metadata or just query without problematic fields
    const comps = await dvGet(
      token,
      `botcomponents?$filter=_parentbotid_value eq ${firstBot.botid}&$select=botcomponentid,name,componenttype&$top=50`,
    ) as { value: Array<{ botcomponentid: string; name: string; componenttype: number }> };
    console.log(`Found ${comps.value.length} components:`);
    const typeCounts: Record<number, number> = {};
    for (const c of comps.value) {
      typeCounts[c.componenttype] = (typeCounts[c.componenttype] ?? 0) + 1;
    }
    console.log('  Component type counts:', typeCounts);
    for (const c of comps.value) {
      console.log(`  [type=${c.componenttype}] id=${c.botcomponentid} "${c.name}"`);
    }

    // 2b. Get all fields on first component to discover schema
    if (comps.value.length > 0) {
      console.log(`\n=== 2b. All fields on first component (schema discovery) ===`);
      const singleComp = await dvGet(
        token,
        `botcomponents(${comps.value[0].botcomponentid})`,
      ) as Record<string, unknown>;
      const keys = Object.keys(singleComp).filter(k => !k.startsWith('@'));
      console.log('  Fields:', keys.join(', '));
      // Print any that look like workflow/flow refs
      for (const k of keys) {
        if (/workflow|flow|action/i.test(k) && singleComp[k]) {
          console.log(`  ${k}:`, singleComp[k]);
        }
      }
    }

    // 3. Check topic content for flow references
    const topics = comps.value.filter(c => c.componenttype === 9); // 9 = topic/dialog
    if (topics.length) {
      console.log(`\n=== 3. First Topic Content (type=9) — looking for flow refs ===`);
      const topicFull = await dvGet(
        token,
        `botcomponents(${topics[0].botcomponentid})?$select=botcomponentid,name,componenttype,content`,
      ) as { botcomponentid: string; name: string; componenttype: number; content?: string };
      console.log(`  Topic: ${topicFull.name}`);
      if (topicFull.content) {
        const contentStr = JSON.stringify(JSON.parse(topicFull.content), null, 2);
        const flowMatches = contentStr.match(/"workflowid[^"]*":\s*"([^"]+)"/gi) ?? [];
        const runFlowMatches = contentStr.match(/RunFlow|InvokeFlow|workflowId|flowId/gi) ?? [];
        console.log('  workflow id refs:', flowMatches.slice(0, 5));
        console.log('  flow keyword hits:', runFlowMatches.slice(0, 5));
        console.log('  content preview:', contentStr.substring(0, 800));
      } else {
        console.log('  no content field');
      }
    }
  }

  // 4. Check workflows that have a bot/solution link
  console.log('\n=== 4. PA Flows (workflows cat=5) with solution info ===');
  const flows = await dvGet(
    token,
    'workflows?$filter=category eq 5&$select=workflowid,name,solutionid,_ownerid_value,statecode&$top=20',
  ) as { value: Array<{ workflowid: string; name: string; solutionid?: string; statecode: number }> };
  console.log(`Found ${flows.value.length} flows:`);
  for (const f of flows.value) {
    console.log(`  [${f.workflowid}] "${f.name}" state=${f.statecode} solution=${f.solutionid ?? 'none'}`);
  }

  // 5. Check solution components — which flows are in the same solution as a bot?
  if (firstBot?.solutionid) {
    console.log(`\n=== 5. Solution Components (solutionid=${firstBot.solutionid}) ===`);
    try {
      const solComps = await dvGet(
        token,
        `solutioncomponents?$filter=solutionid eq ${firstBot.solutionid}&$select=objectid,componenttype&$top=100`,
      ) as { value: Array<{ objectid: string; componenttype: number }> };
      const wfType = solComps.value.filter(c => c.componenttype === 29); // 29 = workflow/flow
      console.log(`Total solution components: ${solComps.value.length}`);
      console.log(`Workflow components (type=29): ${wfType.length}`);
      for (const w of wfType) console.log(`  flow objectid: ${w.objectid}`);
    } catch (e) {
      console.log('  solutioncomponents query failed:', (e as Error).message);
    }
  }

  // 6. Look for workflows table rows that reference bots (via category + solution)
  console.log('\n=== 6. workflows linked via solutioncomponents to any bot ===');
  try {
    // Try: get all bots' solution IDs, find workflows in same solution
    const botSolutions = bots.value.map(b => b.solutionid).filter(Boolean) as string[];
    console.log(`  Bot solution IDs: ${botSolutions.join(', ') || 'none'}`);

    // Also try: query workflows with botcomponent relationship via $expand
    const wfExpand = await dvGet(
      token,
      'workflows?$filter=category eq 5&$select=workflowid,name,solutionid,statecode&$top=30',
    ) as { value: Array<{ workflowid: string; name: string; solutionid?: string; statecode: number }> };
    const agentLinked = wfExpand.value.filter(w => w.solutionid && botSolutions.includes(w.solutionid));
    console.log(`  ${wfExpand.value.length} total cat=5 flows, ${agentLinked.length} in same solution as a bot:`);
    for (const w of agentLinked) {
      console.log(`  [${w.workflowid}] "${w.name}" solutionid=${w.solutionid}`);
    }
    if (!agentLinked.length) {
      console.log('  No solution overlap — all flows:');
      for (const w of wfExpand.value) {
        console.log(`    [${w.workflowid}] "${w.name}" sol=${w.solutionid ?? 'none'}`);
      }
    }
  } catch (e) {
    console.log('  query failed:', (e as Error).message);
  }
}

main().catch(console.error);
export {};
