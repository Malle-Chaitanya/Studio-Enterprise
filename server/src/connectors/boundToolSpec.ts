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
  const usedNames = new Set<string>();

  for (const tool of ir.agentTools ?? []) {
    if (tool.kind !== 'connector' || !tool.connectorId || !tool.operationId) continue;

    const index = await resolveOpIndex(tool.connectorId, ctx);
    if (!index) continue; // reported elsewhere as an unsupported connector

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
      // The author's own words about the tool are what the model routes on. Falling back to
      // the operation id gives it something, but a description is far better.
      description: tool.description || `${index.displayName} ${tool.operationId}`,
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
