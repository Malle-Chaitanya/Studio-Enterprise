/**
 * Scans Dataverse for Copilot Studio agents and their associated PA flows.
 *
 * Discovery strategy (two-level):
 *   Level 1 (fast): solution membership — all cat=5 flows in the same solution
 *                   as any bot. Works for any environment.
 *   Level 2 (precise): topic content scan — reads `data` field of topic components
 *                      looking for InvokeFlowAction / RunFlowAction YAML to find
 *                      the exact agent→flow link. Only runs when topics have data.
 *
 * In production Copilot Studio environments Level 2 gives per-agent flow lists.
 * In demo/empty environments Level 1 returns all solution flows for each agent.
 */

export interface CopilotAgent {
  botId:      string;
  name:       string;
  schemaName: string;
  statusCode: number;
  solutionId: string | null;
}

export interface AgentFlow {
  workflowId: string;
  name:       string;
  solutionId: string | null;
  statecode:  number;
  /** Agents this flow is directly linked to via topic InvokeFlowAction */
  linkedAgents: string[];
  /** True when linked via topic content scan, false when via solution only */
  directLink:   boolean;
}

export interface AgentFlowScanResult {
  agents:      CopilotAgent[];
  flows:       AgentFlow[];
  /** Map: botId → workflowIds */
  agentFlowMap: Record<string, string[]>;
  /** Flows with no direct agent link (solution-only) */
  orphanFlows: string[];
}

// ── Dataverse helpers ─────────────────────────────────────────────────────────

async function dvGet(dvUrl: string, token: string, path: string): Promise<unknown> {
  const res = await fetch(`${dvUrl}/api/data/v9.2/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GET ${path} => ${res.status}: ${t.substring(0, 300)}`);
  }
  return res.json();
}

// ── Topic content parser ──────────────────────────────────────────────────────

/**
 * Extract workflow IDs referenced by InvokeFlowAction in a topic's YAML `data`.
 * Returns [] when no flow actions found.
 */
function extractFlowIdsFromTopicData(data: string): string[] {
  const ids: string[] = [];

  // Pattern: "InvokeFlowAction" or "RunFlowAction" followed by a GUID
  // PVA YAML format: `kind: InvokeFlowAction\nworkflowId: <guid>`
  const lines = data.split('\n');
  let inFlowAction = false;
  for (const line of lines) {
    if (/kind:\s*(InvokeFlowAction|RunFlowAction)/i.test(line)) {
      inFlowAction = true;
    }
    if (inFlowAction && /workflowId|flowId/i.test(line)) {
      const match = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (match) {
        ids.push(match[0].toLowerCase());
        inFlowAction = false;
      }
    }
  }

  // Also look for GUIDs on lines with Flow keywords (looser parse)
  for (const line of lines) {
    if (/InvokeFlow|RunFlow|callFlow/i.test(line)) {
      const matches = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
      for (const m of matches) ids.push(m.toLowerCase());
    }
  }

  return [...new Set(ids)];
}

// ── Main scanner ──────────────────────────────────────────────────────────────

export async function scanAgentFlows(
  dvUrl: string,
  msToken: string,
): Promise<AgentFlowScanResult> {
  // 1. List all Copilot Studio agents
  const botsRes = await dvGet(
    dvUrl, msToken,
    'bots?$select=botid,name,schemaname,statuscode,solutionid&$top=100',
  ) as { value: Array<{ botid: string; name: string; schemaname: string; statuscode: number; solutionid?: string }> };

  const agents: CopilotAgent[] = botsRes.value.map(b => ({
    botId:      b.botid,
    name:       b.name,
    schemaName: b.schemaname,
    statusCode: b.statuscode,
    solutionId: b.solutionid ?? null,
  }));

  // 2. Gather unique solution IDs used by agents
  const agentSolutions = new Set(agents.map(a => a.solutionId).filter(Boolean) as string[]);

  // 3. List all PA flows (category=5)
  const flowsRes = await dvGet(
    dvUrl, msToken,
    'workflows?$filter=category eq 5&$select=workflowid,name,solutionid,statecode&$top=200',
  ) as { value: Array<{ workflowid: string; name: string; solutionid?: string; statecode: number }> };

  // Filter: only flows in the same solution as at least one agent
  const candidateFlows = flowsRes.value.filter(f => f.solutionid && agentSolutions.has(f.solutionid));

  const flows: AgentFlow[] = candidateFlows.map(f => ({
    workflowId:   f.workflowid,
    name:         f.name,
    solutionId:   f.solutionid ?? null,
    statecode:    f.statecode,
    linkedAgents: [],
    directLink:   false,
  }));

  const flowById = new Map(flows.map(f => [f.workflowId.toLowerCase(), f]));

  // 4. Level 2: scan topic data for direct flow links
  for (const agent of agents) {
    let comps: Array<{ botcomponentid: string; name: string; componenttype: number }>;
    try {
      const cr = await dvGet(
        dvUrl, msToken,
        `botcomponents?$filter=_parentbotid_value eq ${agent.botId}&$select=botcomponentid,name,componenttype&$top=200`,
      ) as { value: typeof comps };
      comps = cr.value;
    } catch {
      continue;
    }

    const topics = comps.filter(c => c.componenttype === 9); // 9 = topic/dialog

    for (const topic of topics) {
      let topicData: string;
      try {
        const td = await dvGet(
          dvUrl, msToken,
          `botcomponents(${topic.botcomponentid})?$select=data`,
        ) as { data?: string };
        topicData = td.data ?? '';
      } catch {
        continue;
      }

      const flowIds = extractFlowIdsFromTopicData(topicData);
      for (const fid of flowIds) {
        const flow = flowById.get(fid);
        if (flow) {
          if (!flow.linkedAgents.includes(agent.botId)) {
            flow.linkedAgents.push(agent.botId);
          }
          flow.directLink = true;
        }
      }
    }
  }

  // 5. Build agentFlowMap
  // If direct links found → use them. Otherwise fall back to solution membership.
  const hasAnyDirectLinks = flows.some(f => f.directLink);
  const agentFlowMap: Record<string, string[]> = {};

  for (const agent of agents) {
    if (hasAnyDirectLinks) {
      // Use only directly linked flows for this agent
      agentFlowMap[agent.botId] = flows
        .filter(f => f.linkedAgents.includes(agent.botId))
        .map(f => f.workflowId);
    } else {
      // Fallback: all flows in same solution
      agentFlowMap[agent.botId] = flows
        .filter(f => f.solutionId === agent.solutionId)
        .map(f => f.workflowId);
    }
  }

  // 6. Orphan flows: in candidate list but not linked to any specific agent
  const linkedFlowIds = new Set(Object.values(agentFlowMap).flat());
  const orphanFlows = flows
    .filter(f => !linkedFlowIds.has(f.workflowId))
    .map(f => f.workflowId);

  return { agents, flows, agentFlowMap, orphanFlows };
}
