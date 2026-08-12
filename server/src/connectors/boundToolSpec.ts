/**
 * Turn an agent's Copilot tools into deployable, ARGUMENT-FAITHFUL tool specs.
 *
 * This is where the three proven pieces meet:
 *   - the operation index says the verb, path and parameters (ledger §1.11)
 *   - the vendor binding says which host and credential (operationBinding.ts)
 *   - the payload says what the AUTHOR pinned and what the model fills (ledger §1.13)
 *
 * The result is one tool per operation with the author's fixed arguments baked in, instead
 * of one generic REST tool per connector whose path the model invents. A Copilot tool that
 * listed one table becomes a migrated tool that lists that table — not one that can list
 * any table.
 *
 * WHAT IT REFUSES TO GUESS. A pinned value can be a Power Fx expression over runtime state
 * (`=Concatenate("… eq '", Global.Selected, "'")`). Sending that as a literal would put the
 * word `Concatenate` in the vendor's query. Those arguments are dropped from the call and
 * reported as `needs-review`, and if the expression was REQUIRED the whole operation is
 * refused — a tool that silently omits a required filter returns the wrong rows rather than
 * an error, which is the worse failure.
 */
import type { AgentIR, AgentToolIR, FidelityNote } from '../types.js';
import { bindOperation, type VendorAuth } from './operationBinding.js';
import { resolveOpIndex, type CaptureContext } from './captureOpIndex.js';

/** One deployable operation: everything the container needs to make the call. */
export interface BoundToolSpec {
  /** Python-safe tool name, unique within the agent. */
  toolName: string;
  connectorId: string;
  operationId: string;
  method: string;
  /** Vendor URL with `{placeholders}` intact. */
  urlTemplate: string;
  /** The source agent's own description of the tool — what the model routes on. */
  description: string;
  /** Arguments the author pinned: name → { in, value }. Sent on every call. */
  fixedArgs: Record<string, { in: string; value: string }>;
  /** Arguments the model supplies, i.e. the tool's signature. */
  modelArgs: Array<{ name: string; in: string; required: boolean; type: string; description?: string }>;
  /** Placeholders the container must resolve (`cloudId`, `dataverseOrgUrl`). */
  contextRequired: string[];
  /** Values for those placeholders that the SERVER already knows. */
  contextValues: Record<string, string>;
  auth: VendorAuth;
  aadResource?: string;
}

export interface BoundToolBuild {
  /** connectorId → specs, ready to attach to that connector's LiveConnectorSpec. */
  byConnector: Map<string, BoundToolSpec[]>;
  /** Every refusal and demotion, for the report. Never silent. */
  notes: FidelityNote[];
}

/** `Microsoft Dataverse - Get row` → `microsoft_dataverse_get_row`, unique per agent. */
function toolNameFor(tool: AgentToolIR, operationId: string, used: Set<string>): string {
  const base =
    (tool.displayName || tool.name || operationId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'tool';
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

/**
 * Build deployable specs for every connector tool on this agent.
 *
 * `ctx` lets the operation index come from the CUSTOMER's environment; without it the
 * committed fixtures answer, which is another tenant's view of the same connector.
 */
export async function buildBoundToolSpecs(
  ir: AgentIR,
  ctx: CaptureContext | undefined,
  contextValues: Record<string, string> = {},
): Promise<BoundToolBuild> {
  const byConnector = new Map<string, BoundToolSpec[]>();
  const notes: FidelityNote[] = [];
  /** One policy warning per connector, not one per operation that uses it. */
  const policyWarned = new Set<string>();
  const usedNames = new Set<string>();

  /**
   * MCP servers, expanded into the operations they expose.
   *
   * A Copilot MCP tool carries NO server URL — measured across all 6 in the test tenant.
   * It is reached through the Power Platform proxy, which a migrated agent cannot use, so
   * there is no MCP endpoint for us to call and no amount of deployer code changes that.
   *
   * What it DOES carry, when the author picked specific tools, is the list of tools the
   * server exposes — and those turn out to be ordinary operations on the same connector:
   *
   *     Jira MCP Server  operationId mcp_JiraIssueManagement  toolSelection specific
   *       tools: GetCurrentUser, ListIssues, ListIssues_Datacenter,
   *              ListProjects, ListResources, ListIssueTypes_V2
   *
   * All six are in shared_jira's operation index. So the CAPABILITY is reproducible even
   * though the transport is not: bind each declared tool as a direct vendor call. The
   * agent loses MCP's dynamic discovery and keeps what it actually used.
   *
   * When `toolSelection` is not 'specific' there is no list, and guessing which of a
   * server's tools an agent relied on would be inventing capability. Those are refused by
   * name below instead.
   */
  const expanded = (ir.agentTools ?? []).flatMap((tool) => {
    if (tool.kind !== 'mcp-server') return [tool];
    const declared = tool.mcp?.tools ?? [];
    if (!tool.connectorId || declared.length === 0) return [tool];
    return declared.map((op) => ({
      ...tool,
      kind: 'connector' as const,
      name: `${tool.name} - ${op}`,
      operationId: op,
      // The author pinned nothing on an MCP tool — the server decided the arguments — so
      // every argument is the model's to supply, which is what an empty inputs list means.
      inputs: undefined,
      // The MCP tool's own description names the SERVER ("Jira MCP Server"), so copying
      // it onto all six operations gives the model six identically-described tools it
      // cannot choose between. Drop it and let the connector's per-operation description
      // answer — that is what MCP itself would have advertised at run time.
      description: undefined,
    }));
  });

  // An MCP server we could NOT expand is reported by the orchestrator's per-tool pass,
  // which knows how many of the declared tools actually bound. Emitting a note here too
  // would put two `tool:<name>` entries in the same report for one tool.

  for (const tool of expanded) {
    if (tool.kind !== 'connector' || !tool.connectorId || !tool.operationId) continue;

    const index = await resolveOpIndex(tool.connectorId, ctx);
    if (!index) continue; // reported elsewhere as an unsupported connector

    // A custom connector can apply POLICIES that rewrite the request before it reaches the
    // backend — inject headers, remap query parameters, change the host. We reproduce the
    // published definition, not the policies, so where any exist our call may differ from
    // Copilot's in a way neither we nor the customer can see from the outside. Say so once
    // per connector rather than let a silently different call pass as a faithful one.
    if (index.policyCount && !policyWarned.has(tool.connectorId)) {
      policyWarned.add(tool.connectorId);
      notes.push({
        component: `connector:${tool.connectorId}`,
        status: 'needs-review',
        detail:
          `${index.displayName} applies ${index.policyCount} Power Platform policy/policies that rewrite the ` +
          'request before it reaches the vendor. The migrated tools call the vendor API directly from the ' +
          'connector definition, so any header, parameter or host the policies changed is not reproduced — ' +
          'compare a result against the original agent before relying on it.',
      });
    }

    const bound = bindOperation(index, tool.operationId);
    if (bound.status !== 'bindable') {
      // The per-operation refusal is already reported by the orchestrator's readiness pass;
      // adding a second note here would double-count the same loss in the report.
      continue;
    }
    const op = bound.operation;

    const fixedArgs: Record<string, { in: string; value: string }> = {};
    const paramByName = new Map(op.parameters.map((p) => [p.name, p]));
    let refuse: string | undefined;

    for (const input of tool.inputs ?? []) {
      const param = paramByName.get(input.name);
      if (input.source === 'model') continue; // stays in the signature
      if (input.source === 'unknown') {
        notes.push({
          component: `tool:${tool.name}:${input.name}`,
          status: 'needs-review',
          detail:
            `The source agent binds "${input.name}" with an input kind we do not recognise ` +
            `(${input.rawKind ?? 'unnamed'}), so the migrated tool leaves it to the model.`,
        });
        continue;
      }
      if (input.isExpression) {
        // A Power Fx expression over runtime state. Copying it through would send the
        // formula text to the vendor.
        if (param?.required || input.name === 'entityName') {
          refuse =
            `"${input.name}" is computed at run time in Copilot (${(input.value ?? '').slice(0, 80)}…) ` +
            'and is required for this call, so the tool would silently query the wrong data.';
          break;
        }
        notes.push({
          component: `tool:${tool.name}:${input.name}`,
          status: 'needs-review',
          detail:
            `The source agent computes "${input.name}" at run time from Copilot state ` +
            `(${(input.value ?? '').slice(0, 80)}). The migrated tool leaves it to the model instead, ` +
            'so results may differ from the original agent.',
        });
        continue;
      }
      if (input.value === undefined) continue;
      fixedArgs[input.name] = { in: param?.in ?? 'query', value: input.value };
    }

    if (refuse) {
      notes.push({
        component: `tool:${tool.name}`,
        status: 'lost',
        detail: `"${tool.name}" was not recreated. ${refuse}`,
      });
      continue;
    }

    // Anything the author did not pin is the model's to supply.
    const modelArgs = op.parameters
      .filter((p) => !(p.name in fixedArgs))
      // Body parameters need a schema the swagger does not always give us; a string body
      // argument is honest and lets the model pass JSON when it has to.
      .map((p) => {
        const declared = (tool.inputs ?? []).find((i) => i.name === p.name && i.source === 'model');
        return { name: p.name, in: p.in, required: p.required, type: p.type, description: declared?.description };
      });

    const spec: BoundToolSpec = {
      toolName: toolNameFor(tool, tool.operationId, usedNames),
      connectorId: tool.connectorId,
      operationId: tool.operationId,
      method: op.method,
      urlTemplate: op.urlTemplate,
      // The author's own words about the tool are what the model routes on. Where the agent
      // stores none, the connector's own operation description is the next best thing and
      // is often the SAME TEXT: Copilot Studio's Tool details pane renders "Retrieve a list
      // of HubSpot deals" straight from the connector definition, because a ConnectorTool
      // row persists no description at all. Reaching for it here is what stops four HubSpot
      // tools arriving as "Get CRM objects from Hubspot GetDeals/GetTickets/…" — strings a
      // model cannot choose between. The operation id remains the last resort.
      description:
        tool.description ||
        index.operations[tool.operationId]?.summary ||
        `${index.displayName} ${tool.operationId}`,
      fixedArgs,
      modelArgs,
      contextRequired: op.contextRequired,
      contextValues: Object.fromEntries(
        op.contextRequired.filter((c) => contextValues[c]).map((c) => [c, contextValues[c]]),
      ),
      auth: op.auth,
      aadResource: op.aadResource,
    };
    const list = byConnector.get(tool.connectorId) ?? [];
    list.push(spec);
    byConnector.set(tool.connectorId, list);
  }

  return { byConnector, notes };
}
