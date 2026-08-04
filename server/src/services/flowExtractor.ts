/**
 * Flow extraction: reads all Power Automate flows from any customer's Dataverse
 * and builds normalized FlowIR objects the mapper + Hermas can consume.
 *
 * Follows the exact same pattern as dataverse.ts:
 *   - dvGetAll() for paginated queries
 *   - (url, token) params — works for any customer tenant
 *   - never throws on non-fatal failures — degrades gracefully
 */

import { logger } from '../logger.js';
import type {
  FlowAction,
  FlowConnector,
  FlowConfidenceBreakdown,
  FlowGap,
  FlowIR,
  FlowTrigger,
} from '../types.js';

// ── Dataverse helpers (same pattern as dataverse.ts) ─────────────────────────

const API = (url: string, path: string) => `${url}/api/data/v9.2/${path}`;

async function dvGetAll<T>(url: string, token: string, path: string): Promise<T[]> {
  const rows: T[] = [];
  let next: string | null = API(url, path);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    Prefer: 'odata.maxpagesize=500',
  };
  while (next) {
    const res = await fetch(next, { headers });
    if (!res.ok) throw new Error(`Dataverse GET failed (${res.status}): ${path}`);
    const json = (await res.json()) as { value?: T[]; '@odata.nextLink'?: string };
    rows.push(...(json.value ?? []));
    next = json['@odata.nextLink'] ?? null;
  }
  return rows;
}

// ── Raw Dataverse shape ───────────────────────────────────────────────────────

interface RawWorkflow {
  workflowid: string;
  name: string;
  statecode: number;
  category: number;
  clientdata: string | null;
  createdon?: string | null;
  modifiedon?: string | null;
}

// ── Known connector registry ──────────────────────────────────────────────────
// Connectors we have rule-based mappers for. Anything outside this set
// goes to Hermas. Add here as we build more mappers.

const KNOWN_CONNECTORS = new Set([
  'shared_commondataserviceforapps', // Dataverse CRUD + custom actions
  'shared_commondataservice',        // older Dataverse connector name
  'shared_microsoftcopilotstudio',   // Copilot agent calls → Gemini Interactions API
  'shared_teams',                    // Teams messages → Google Chat
  'shared_conversionservice',        // HTML → text → Cloud Function
  'shared_office365',                // Email → Gmail API
  'shared_sharepointonline',         // SharePoint files → Google Drive
  'shared_http',                     // Raw HTTP → pass-through
]);

// ── Trigger parsing ───────────────────────────────────────────────────────────

function parseTrigger(triggers: Record<string, unknown>): FlowTrigger {
  const entries = Object.values(triggers);
  if (entries.length === 0) {
    return { type: 'Unknown', rawType: 'none' };
  }

  const t = entries[0] as Record<string, unknown>;
  const rawType = (t.type as string) ?? 'Unknown';

  // Recurrence
  if (rawType === 'Recurrence') {
    const rec = (t.recurrence ?? (t.inputs as Record<string, unknown>)?.recurrence ?? {}) as Record<string, unknown>;
    const frequency = String(rec.frequency ?? 'Minute').toLowerCase();
    const interval = Number(rec.interval ?? 1);
    const freqToMinutes: Record<string, number> = {
      minute: 1, hour: 60, day: 1440, week: 10080, month: 43200,
    };
    const recurrenceMinutes = (freqToMinutes[frequency] ?? 1) * interval;
    return {
      type: 'Recurrence',
      rawType,
      recurrenceMinutes,
      recurrenceRaw: { frequency, interval },
    };
  }

  // Dataverse webhook
  if (rawType === 'OpenApiConnectionWebhook') {
    const params = ((t.inputs as Record<string, unknown>)?.parameters ?? {}) as Record<string, unknown>;
    const entity =
      (params['subscriptionRequest/entityname'] as string) ??
      (params['subscriptionRequest/filteringAttributes'] as string)?.split(',')[0] ??
      undefined;
    const message = (params['subscriptionRequest/message'] as string) ?? undefined;
    const filter = (params['subscriptionRequest/filteringAttributes'] as string) ?? undefined;
    return { type: 'Webhook', rawType, entity, message, filterExpression: filter };
  }

  // Manual trigger ("Manually trigger a flow" button / agent-called flow)
  if (rawType === 'Request' && (t.kind as string) === 'Button') {
    const schema = ((t.inputs as Record<string, unknown>)?.schema ?? {}) as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const requiredFields = (schema.required ?? []) as string[];
    const inputs: Record<string, { type: string; description?: string; required?: boolean }> = {};
    for (const [key, prop] of Object.entries(props)) {
      inputs[key] = {
        type: String(prop.type ?? 'string'),
        description: String(prop.title ?? prop.description ?? key),
        required: requiredFields.includes(key),
      };
    }
    return { type: 'Manual', rawType, inputs };
  }

  // HTTP Request trigger (inbound webhook — no kind, or kind !== Button)
  if (rawType === 'Request' || rawType === 'HttpWebhook') {
    return { type: 'HttpRequest', rawType };
  }

  return { type: 'Unknown', rawType };
}

// ── Action parsing ────────────────────────────────────────────────────────────

function parseActions(
  actionsNode: Record<string, unknown>,
  depth = 0,
): FlowAction[] {
  if (depth > 6) return []; // guard against pathological nesting
  const result: FlowAction[] = [];

  for (const [name, raw] of Object.entries(actionsNode)) {
    const a = raw as Record<string, unknown>;
    const type = (a.type as string) ?? 'Unknown';
    const inputs = (a.inputs ?? {}) as Record<string, unknown>;
    const params = (inputs.parameters ?? {}) as Record<string, unknown>;
    const host = (inputs.host ?? {}) as Record<string, unknown>;

    const connector = (host.apiId as string)?.split('/').pop() ?? undefined;
    const operationId = (host.operationId as string) ?? undefined;
    const actionName = (params.actionName as string) ?? (params['item/actionName'] as string) ?? undefined;
    const entity =
      (params.entityName as string) ??
      (params['item/entityName'] as string) ??
      (params['subscriptionRequest/entityname'] as string) ??
      undefined;

    result.push({
      name,
      type,
      connector,
      operationId,
      actionName,
      entity,
      rawInputs: Object.keys(inputs).length > 0 ? inputs : undefined,
    });

    // Recurse into branches: If/Switch/Foreach/Until/Scope all have nested actions
    for (const branchKey of ['actions', 'else', 'cases', 'default', 'branches']) {
      const branch = a[branchKey];
      if (branch && typeof branch === 'object' && !Array.isArray(branch)) {
        result.push(...parseActions(branch as Record<string, unknown>, depth + 1));
      }
    }
    // Switch cases
    const cases = a.cases as Record<string, { actions?: Record<string, unknown> }> | undefined;
    if (cases) {
      for (const c of Object.values(cases)) {
        if (c.actions) result.push(...parseActions(c.actions, depth + 1));
      }
    }
  }

  return result;
}

// ── Connector extraction ──────────────────────────────────────────────────────

function extractConnectors(
  connectionRefs: Record<string, unknown>,
): FlowConnector[] {
  return Object.values(connectionRefs).map((ref) => {
    const r = ref as Record<string, unknown>;
    const apiName = ((r.api as Record<string, unknown>)?.name as string) ?? '';
    const displayName = (r.displayName as string) ?? apiName;
    return {
      displayName,
      apiName,
      known: KNOWN_CONNECTORS.has(apiName),
    };
  });
}

// ── Confidence scoring ────────────────────────────────────────────────────────

function scoreFlow(
  trigger: FlowTrigger,
  actions: FlowAction[],
  connectors: FlowConnector[],
): FlowConfidenceBreakdown {
  let score = 100;
  const unknownConnectors: string[] = [];
  const unknownActions: string[] = [];
  const gaps: FlowGap[] = [];

  // Unknown trigger type
  if (trigger.type === 'Unknown') {
    score -= 30;
    gaps.push({
      id: 'unknown_trigger',
      question: `This flow uses an unsupported trigger type "${trigger.rawType}". How should it be triggered in Google Cloud?`,
      options: ['Cloud Scheduler (time-based)', 'Pub/Sub (event-based)', 'HTTP endpoint', 'Skip this flow'],
      defaultOption: 'HTTP endpoint',
    });
  }

  // Unknown connectors
  for (const c of connectors) {
    if (!c.known) {
      score -= 20;
      unknownConnectors.push(c.apiName);
      gaps.push({
        id: `connector_${c.apiName}`,
        question: `"${c.displayName}" has no automatic mapping. Does this service have a REST API we can call directly?`,
        options: ['Yes — provide API endpoint', 'Keep calling via Microsoft (hybrid)', 'Skip actions using this connector'],
        defaultOption: 'Yes — provide API endpoint',
      });
    }
  }

  // Unknown action types (structural)
  const KNOWN_ACTION_TYPES = new Set([
    'OpenApiConnection', 'If', 'Foreach', 'Until', 'Scope',
    'Terminate', 'Wait', 'Compose', 'SetVariable', 'InitializeVariable',
    'AppendToArrayVariable', 'AppendToStringVariable', 'ParseJson',
    'Response', 'Http',
  ]);
  for (const a of actions) {
    if (!KNOWN_ACTION_TYPES.has(a.type)) {
      score -= 5;
      unknownActions.push(a.type);
    }
  }

  // Teams → ask if customer wants Google Chat
  const hasTeams = connectors.some((c) => c.apiName === 'shared_teams');
  if (hasTeams) {
    gaps.push({
      id: 'teams_destination',
      question: 'This flow sends Microsoft Teams messages. Where should they go in Google?',
      options: ['Google Chat', 'Keep sending to Teams (hybrid)', 'Skip Teams messages'],
      defaultOption: 'Google Chat',
    });
  }

  // Copilot Studio → Gemini swap (known but needs agent ID mapping)
  const hasCopilot = connectors.some((c) => c.apiName === 'shared_microsoftcopilotstudio');
  if (hasCopilot) {
    gaps.push({
      id: 'agent_mapping',
      question: 'This flow calls a Copilot Studio agent. Which migrated Gemini agent should it call?',
      options: ['Auto-detect from agent migration', 'Specify manually'],
      defaultOption: 'Auto-detect from agent migration',
    });
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  const strategy: FlowConfidenceBreakdown['strategy'] =
    score >= 80 ? 'rule-based'
    : score >= 50 ? 'hybrid'
    : score >= 10 ? 'hermas'
    : 'unsupported';

  return {
    score,
    unknownConnectors: [...new Set(unknownConnectors)],
    unknownActions: [...new Set(unknownActions)],
    gaps,
    strategy,
  };
}

// ── Main extractor ────────────────────────────────────────────────────────────

/** List all active Power Automate flows in the environment (lightweight — no clientdata). */
export async function listFlows(
  url: string,
  token: string,
): Promise<{ workflowid: string; name: string; statecode: number }[]> {
  const rows = await dvGetAll<RawWorkflow>(
    url,
    token,
    'workflows?$select=workflowid,name,statecode&$filter=category eq 5',
  );
  return rows.map((r) => ({ workflowid: r.workflowid, name: r.name, statecode: r.statecode }));
}

/** Extract one flow into a complete FlowIR. */
export async function extractFlow(
  url: string,
  token: string,
  workflowId: string,
): Promise<FlowIR> {
  const rows = await dvGetAll<RawWorkflow>(
    url,
    token,
    `workflows?$select=workflowid,name,statecode,clientdata,createdon,modifiedon` +
      `&$filter=workflowid eq ${workflowId}&$top=1`,
  );

  const raw = rows[0];
  if (!raw) throw new Error(`Flow ${workflowId} not found`);

  return parseRawFlow(raw);
}

/** Extract ALL flows in one paginated query (efficient — single round-trip set). */
export async function extractAllFlows(
  url: string,
  token: string,
): Promise<FlowIR[]> {
  const rows = await dvGetAll<RawWorkflow>(
    url,
    token,
    'workflows?$select=workflowid,name,statecode,clientdata,createdon,modifiedon' +
      '&$filter=category eq 5&$orderby=name asc',
  );

  logger.info({ env: url, total: rows.length }, 'fetched raw flows from Dataverse');

  const flows: FlowIR[] = [];
  for (const row of rows) {
    try {
      flows.push(parseRawFlow(row));
    } catch (e) {
      logger.warn({ flowId: row.workflowid, name: row.name, err: (e as Error).message }, 'flow parse failed — skipped');
    }
  }

  logger.info(
    {
      env: url,
      parsed: flows.length,
      failed: rows.length - flows.length,
      byTrigger: summariseByTrigger(flows),
      byStrategy: summariseByStrategy(flows),
    },
    'flow extraction complete',
  );

  return flows;
}

// ── Parsing one raw row ───────────────────────────────────────────────────────

function parseRawFlow(raw: RawWorkflow): FlowIR {
  const unmapped: string[] = [];

  // clientdata is a JSON string — the full PA flow definition
  let definition: Record<string, unknown> = {};
  if (raw.clientdata) {
    try {
      definition = JSON.parse(raw.clientdata) as Record<string, unknown>;
    } catch {
      unmapped.push('clientdata could not be parsed as JSON');
    }
  } else {
    unmapped.push('clientdata is empty — flow definition unavailable');
  }

  const props = (definition.properties ?? {}) as Record<string, unknown>;
  const def = (props.definition ?? {}) as Record<string, unknown>;
  const triggersNode = (def.triggers ?? {}) as Record<string, unknown>;
  const actionsNode = (def.actions ?? {}) as Record<string, unknown>;
  const connRefsNode = (props.connectionReferences ?? {}) as Record<string, unknown>;

  const trigger = parseTrigger(triggersNode);
  const actions = parseActions(actionsNode);
  const connectors = extractConnectors(connRefsNode);
  const confidence = scoreFlow(trigger, actions, connectors);

  // Surface unmapped patterns for the fidelity report
  if (confidence.unknownConnectors.length) {
    unmapped.push(`Unknown connectors: ${confidence.unknownConnectors.join(', ')}`);
  }
  if (confidence.unknownActions.length) {
    unmapped.push(`Unknown action types: ${[...new Set(confidence.unknownActions)].join(', ')}`);
  }
  if (trigger.type === 'Unknown') {
    unmapped.push(`Unknown trigger: ${trigger.rawType}`);
  }

  return {
    sourceId: raw.workflowid,
    name: raw.name,
    statecode: raw.statecode,
    trigger,
    actions,
    connectors,
    confidence,
    rawDefinition: definition,
    unmapped,
  };
}

// ── Summary helpers ───────────────────────────────────────────────────────────

function summariseByTrigger(flows: FlowIR[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of flows) {
    counts[f.trigger.type] = (counts[f.trigger.type] ?? 0) + 1;
  }
  return counts;
}

function summariseByStrategy(flows: FlowIR[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of flows) {
    const s = f.confidence.strategy;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}
