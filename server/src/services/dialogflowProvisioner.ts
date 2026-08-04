/**
 * Programmatic provisioning of a Dialogflow CX agent for migrated Cloud Workflows.
 *
 * Called automatically at the end of migration — no manual steps for the customer.
 *
 * Creates (or reuses) a Dialogflow CX agent, registers each migrated workflow
 * as a functionSpec tool, adds a webhook pointing to our Cloud Run server,
 * and creates a playbook that routes user intent to the tools.
 */

const DF_API = (project: string, location: string) =>
  `https://${location}-dialogflow.googleapis.com/v3beta1/projects/${project}/locations/${location}`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkflowToolDef {
  /** Human-readable name (e.g. "Create Task") */
  displayName: string;
  /** snake_case operationId used in functionSpec and webhook routing */
  operationId: string;
  description: string;
  gcpProject: string;
  gcpRegion: string;
  gcpWorkflow: string;
  params: Record<string, { type: string; description: string; required?: boolean }>;
}

export interface ProvisionResult {
  agentId: string;
  agentResourceName: string;
  consoleUrl: string;
  webhookId: string;
  toolIds: string[];
  playbookId: string;
}

// ── Core provisioner ──────────────────────────────────────────────────────────

export async function provisionMigrationAgent(opts: {
  gcpToken: string;
  project: string;
  location: string;
  agentDisplayName: string;
  tools: WorkflowToolDef[];
  webhookUrl: string;
}): Promise<ProvisionResult> {
  const { gcpToken, project, location, agentDisplayName, tools, webhookUrl } = opts;
  const base = DF_API(project, location);
  const headers = { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' };

  // ── 1. Find or create agent ────────────────────────────────────────────────
  const agentId = await findOrCreateAgent(base, headers, agentDisplayName, project);
  const agentBase = `${base}/agents/${agentId}`;

  // ── 2. Create webhook ──────────────────────────────────────────────────────
  const webhookId = await upsertWebhook(agentBase, headers, webhookUrl);

  // ── 3. Create functionSpec tools ───────────────────────────────────────────
  const toolIds: string[] = [];
  const toolResourceNames: string[] = [];
  for (const tool of tools) {
    const { toolId, toolResource } = await upsertTool(agentBase, headers, tool);
    toolIds.push(toolId);
    toolResourceNames.push(toolResource);
  }

  // ── 4. Create playbook ─────────────────────────────────────────────────────
  const playbookId = await upsertPlaybook(agentBase, headers, tools, toolResourceNames, webhookId, project, location, agentId);

  return {
    agentId,
    agentResourceName: `projects/${project}/locations/${location}/agents/${agentId}`,
    consoleUrl: `https://dialogflow.cloud.google.com/cx/projects/${project}/locations/${location}/agents/${agentId}`,
    webhookId,
    toolIds,
    playbookId,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findOrCreateAgent(
  base: string,
  headers: Record<string, string>,
  displayName: string,
  _project: string,
): Promise<string> {
  // List agents and find by displayName
  const listRes = await fetch(`${base}/agents`, { headers: { Authorization: headers['Authorization']! } });
  if (listRes.ok) {
    const list = await listRes.json() as { agents?: Array<{ name: string; displayName: string }> };
    const existing = (list.agents ?? []).find(a => a.displayName === displayName);
    if (existing) return existing.name.split('/').pop()!;
  }

  // Create new agent
  const body = {
    displayName,
    defaultLanguageCode: 'en',
    timeZone: 'America/New_York',
    description: 'Auto-provisioned by CloudFuze Studio Migrate — triggers migrated Cloud Workflows.',
  };
  const createRes = await fetch(`${base}/agents`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!createRes.ok) {
    const t = await createRes.text();
    throw new Error(`Create agent failed (${createRes.status}): ${t.substring(0, 300)}`);
  }
  const agent = await createRes.json() as { name: string };
  return agent.name.split('/').pop()!;
}

async function upsertWebhook(
  agentBase: string,
  headers: Record<string, string>,
  webhookUrl: string,
): Promise<string> {
  const WEBHOOK_NAME = 'studio-enterprise-tool-handler';

  // List webhooks
  const listRes = await fetch(`${agentBase}/webhooks`, { headers: { Authorization: headers['Authorization']! } });
  if (listRes.ok) {
    const list = await listRes.json() as { webhooks?: Array<{ name: string; displayName: string }> };
    const existing = (list.webhooks ?? []).find(w => w.displayName === WEBHOOK_NAME);
    if (existing) {
      // Update URL in case it changed
      const patchRes = await fetch(`${existing.name}?updateMask=genericWebService.uri`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ genericWebService: { uri: webhookUrl } }),
      });
      if (patchRes.ok) return existing.name.split('/').pop()!;
    }
  }

  const body = {
    displayName: WEBHOOK_NAME,
    genericWebService: { uri: webhookUrl },
  };
  const res = await fetch(`${agentBase}/webhooks`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Create webhook failed (${res.status}): ${t.substring(0, 300)}`);
  }
  const wh = await res.json() as { name: string };
  return wh.name.split('/').pop()!;
}

async function upsertTool(
  agentBase: string,
  headers: Record<string, string>,
  tool: WorkflowToolDef,
): Promise<{ toolId: string; toolResource: string }> {
  // List tools, reuse if same displayName
  const listRes = await fetch(`${agentBase}/tools`, { headers: { Authorization: headers['Authorization']! } });
  if (listRes.ok) {
    const list = await listRes.json() as { tools?: Array<{ name: string; displayName: string }> };
    const existing = (list.tools ?? []).find(t => t.displayName === tool.displayName);
    if (existing) {
      return { toolId: existing.name.split('/').pop()!, toolResource: existing.name };
    }
  }

  const required = Object.entries(tool.params)
    .filter(([, v]) => v.required)
    .map(([k]) => k);

  const body = {
    displayName: tool.displayName,
    description: tool.description,
    functionSpec: {
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(tool.params).map(([k, v]) => [k, { type: v.type, description: v.description }]),
        ),
        ...(required.length ? { required } : {}),
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  };

  const res = await fetch(`${agentBase}/tools`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Create tool "${tool.displayName}" failed (${res.status}): ${t.substring(0, 300)}`);
  }
  const created = await res.json() as { name: string };
  return { toolId: created.name.split('/').pop()!, toolResource: created.name };
}

async function upsertPlaybook(
  agentBase: string,
  headers: Record<string, string>,
  tools: WorkflowToolDef[],
  toolResourceNames: string[],
  webhookId: string,
  project: string,
  location: string,
  agentId: string,
): Promise<string> {
  const PLAYBOOK_NAME = 'Migration Workflows Playbook';
  const webhookResource = `projects/${project}/locations/${location}/agents/${agentId}/webhooks/${webhookId}`;

  const toolInstructions = tools.map(t =>
    `- When user asks about "${t.displayName.toLowerCase()}", collect the required fields (${Object.keys(t.params).join(', ')}) and call the ${t.displayName} tool.`,
  ).join('\n');

  const body = {
    displayName: PLAYBOOK_NAME,
    goal: 'Help users trigger their migrated Cloud Workflows by collecting required inputs and executing them.',
    instruction: {
      steps: [
        { text: 'Greet the user and ask what workflow they want to trigger.' },
        { text: toolInstructions },
        { text: 'After calling a tool, report the result clearly to the user.' },
        { text: 'If the user asks about something unrelated to the available workflows, politely decline.' },
      ],
    },
    referencedTools: toolResourceNames,
    referencedPlaybooks: [],
    tokenCount: 0,
  };

  const webhookHandlerBody = {
    tag: 'tool-handler',
    webhook: webhookResource,
  };

  // List playbooks and reuse
  const listRes = await fetch(`${agentBase}/playbooks`, { headers: { Authorization: headers['Authorization']! } });
  if (listRes.ok) {
    const list = await listRes.json() as { playbooks?: Array<{ name: string; displayName: string }> };
    const existing = (list.playbooks ?? []).find(p => p.displayName === PLAYBOOK_NAME);
    if (existing) {
      // PATCH to update
      await fetch(`${existing.name}?updateMask=instruction,referencedTools`, {
        method: 'PATCH', headers, body: JSON.stringify(body),
      });
      return existing.name.split('/').pop()!;
    }
  }

  const res = await fetch(`${agentBase}/playbooks`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Create playbook failed (${res.status}): ${t.substring(0, 300)}`);
  }
  const playbook = await res.json() as { name: string };

  // Set as start playbook on agent
  await fetch(`${agentBase}?updateMask=startPlaybook`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ startPlaybook: playbook.name }),
  });

  void webhookHandlerBody; // used via the tool handler tag at runtime
  return playbook.name.split('/').pop()!;
}
