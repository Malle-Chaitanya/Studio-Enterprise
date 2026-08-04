/**
 * Flow mapper: converts a FlowIR (Power Automate intermediate representation)
 * into Google Cloud Workflow YAML.
 *
 * Rule-based, deterministic — no LLM. Every supported connector / action type
 * has an explicit mapping. Unsupported constructs generate TODO comments in the
 * YAML and surface as warnings in MapperResult so the customer knows exactly
 * what needs human review.
 */

import type { FlowIR, FlowAction } from '../types.js';
import { buildConnectorStep } from './connectorYaml.js';

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface MapperResult {
  /** Full Google Cloud Workflow YAML string (empty when unsupported=true). */
  yaml: string;
  /** 0–100 confidence that the mapping is correct. */
  confidence: number;
  /** Human-readable notes about constructs that may need review. */
  warnings: string[];
  /** Present for Recurrence-triggered flows — wire up Cloud Scheduler. */
  schedulerConfig?: SchedulerConfig;
  /** Present for Webhook-triggered flows — wire up a Pub/Sub subscription. */
  pubSubConfig?: PubSubConfig;
  /** True when the mapper cannot produce usable YAML at all. */
  unsupported: boolean;
  /** Explanation when unsupported=true. */
  unsupportedReason?: string;
}

export interface SchedulerConfig {
  jobName: string;
  /** Cron expression, e.g. "0 9 * * 1" */
  schedule: string;
  timeZone: string;
  workflowName: string;
}

export interface PubSubConfig {
  topicName: string;
  workflowName: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface MappingContext {
  warnings: string[];
  confidence: number;
  /** Tracks all step names emitted so far — used to enforce uniqueness. */
  stepNames: Set<string>;
  /** Customer answers collected during gap-fill (includes connector_* keys). */
  customerAnswers: Record<string, string>;
}

// ── YAML string escaping ──────────────────────────────────────────────────────

/**
 * Safely encode a value as a YAML scalar.
 * - PA expressions (@{...}) → string literal (expression not evaluated)
 * - Strings with double-quotes → single-quoted YAML (single quotes escaped as '')
 * - Strings with special chars → single-quoted YAML
 * - Numbers / booleans → bare literal
 */
function yamlScalar(raw: unknown): string {
  if (raw === null || raw === undefined) return '""';
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (typeof raw !== 'string') return JSON.stringify(raw);

  // If the string is simple (no quotes, braces, colons, newlines) use double-quoted
  if (!/["{}\n\r:'\\]/.test(raw) && raw.trim() === raw) {
    return `"${raw}"`;
  }

  // Otherwise single-quote and escape internal single quotes as ''
  const escaped = raw.replace(/'/g, "''");
  return `'${escaped}'`;
}

// ── Name utilities ────────────────────────────────────────────────────────────

/** Convert an arbitrary string to a valid snake_case Cloud Workflows step name. */
function toSnakeCase(s: string): string {
  return (
    s
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '')
      .toLowerCase() || 'step'
  );
}

/** Return a unique step name, appending _2, _3, … when there are collisions. */
function uniqueStep(base: string, ctx: MappingContext): string {
  const snake = toSnakeCase(base);
  if (!ctx.stepNames.has(snake)) {
    ctx.stepNames.add(snake);
    return snake;
  }
  let i = 2;
  while (ctx.stepNames.has(`${snake}_${i}`)) i++;
  const name = `${snake}_${i}`;
  ctx.stepNames.add(name);
  return name;
}

/** Convert a flow name to a valid Cloud Workflow resource name (lowercase-dashes). */
function toWorkflowName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 63);
}

// ── Recurrence → cron ─────────────────────────────────────────────────────────

function minutesToCron(minutes: number): string {
  if (minutes === 60) return '0 * * * *';       // hourly
  if (minutes === 1440) return '0 0 * * *';     // daily at midnight
  if (minutes === 10080) return '0 0 * * 1';    // weekly on Monday
  // generic interval — cap at 60 to stay within cron's minute-field range
  const safeMin = Math.min(minutes, 59);
  return `*/${safeMin} * * * *`;
}

// ── Dataverse operationId → HTTP verb ────────────────────────────────────────

const GET_OPS = new Set([
  'GetItem', 'ListRecords', 'RetrieveMultipleRecords', 'GetItems',
  'GetRecord', 'ListItems', 'GetList',
]);
const POST_OPS = new Set([
  'CreateRecord', 'PostItem', 'CreateItem', 'AddToCollection',
  'PerformUnboundAction', 'PerformBoundAction', 'ExecuteAction',
]);
const PATCH_OPS = new Set([
  'UpdateRecord', 'PatchItem', 'UpdateItem', 'UpdateRecord_V2',
]);
const DELETE_OPS = new Set([
  'DeleteRecord', 'DeleteItem', 'RemoveItem',
]);

function dvHttpVerb(operationId: string | undefined): string {
  if (!operationId) return 'get';
  if (GET_OPS.has(operationId)) return 'get';
  if (POST_OPS.has(operationId)) return 'post';
  if (PATCH_OPS.has(operationId)) return 'patch';
  if (DELETE_OPS.has(operationId)) return 'delete';
  return 'get';
}

/** Resolve the Dataverse OData collection/action path from a FlowAction. */
function dvEntityPath(action: FlowAction): string {
  if (action.entity) return action.entity;
  if (action.actionName) return `Microsoft.Dynamics.CRM.${action.actionName}`;
  return 'records';
}

// ── Fixed YAML fragments ──────────────────────────────────────────────────────

/**
 * Every generated workflow acquires an Entra (Azure AD) token first.
 * Credentials are passed as runtime args — never hardcoded.
 */
const ENTRA_TOKEN_STEP = `    - get_entra_token:
        call: http.post
        args:
          url: \${"https://login.microsoftonline.com/" + args.tenant_id + "/oauth2/v2.0/token"}
          headers:
            Content-Type: application/x-www-form-urlencoded
          body:
            client_id: \${args.client_id}
            client_secret: \${args.client_secret}
            grant_type: client_credentials
            scope: \${"https://" + args.org_url + "/.default"}
        result: entra_token_response
    - extract_token:
        assign:
          - entra_token: \${entra_token_response.body.access_token}`;

/**
 * Secret Manager variant: reads MS credentials from GCP Secret Manager instead
 * of from workflow args. Use when opts.useSecretManager is true.
 */
const ENTRA_TOKEN_STEP_SM = `    - get_ms_tenant_id:
        call: http.get
        args:
          url: \${"https://secretmanager.googleapis.com/v1/projects/" + args.gcp_project + "/secrets/studio-enterprise-ms-tenant-id/versions/latest:access"}
          auth:
            type: OAuth2
        result: tenant_id_resp
    - get_ms_client_id:
        call: http.get
        args:
          url: \${"https://secretmanager.googleapis.com/v1/projects/" + args.gcp_project + "/secrets/studio-enterprise-ms-client-id/versions/latest:access"}
          auth:
            type: OAuth2
        result: client_id_resp
    - get_ms_client_secret:
        call: http.get
        args:
          url: \${"https://secretmanager.googleapis.com/v1/projects/" + args.gcp_project + "/secrets/studio-enterprise-ms-client-secret/versions/latest:access"}
          auth:
            type: OAuth2
        result: client_secret_resp
    - get_ms_org_url:
        call: http.get
        args:
          url: \${"https://secretmanager.googleapis.com/v1/projects/" + args.gcp_project + "/secrets/studio-enterprise-ms-org-url/versions/latest:access"}
          auth:
            type: OAuth2
        result: org_url_resp
    - decode_ms_secrets:
        assign:
          - ms_tenant_id: \${text.decode(base64.decode(tenant_id_resp.body.payload.data))}
          - ms_client_id: \${text.decode(base64.decode(client_id_resp.body.payload.data))}
          - ms_client_secret: \${text.decode(base64.decode(client_secret_resp.body.payload.data))}
          - ms_org_url: \${text.decode(base64.decode(org_url_resp.body.payload.data))}
    - get_entra_token:
        call: http.post
        args:
          url: \${"https://login.microsoftonline.com/" + ms_tenant_id + "/oauth2/v2.0/token"}
          headers:
            Content-Type: application/x-www-form-urlencoded
          body:
            client_id: \${ms_client_id}
            client_secret: \${ms_client_secret}
            grant_type: client_credentials
            scope: \${"https://" + ms_org_url + "/.default"}
        result: entra_token_response
    - extract_token:
        assign:
          - entra_token: \${entra_token_response.body.access_token}`;

/**
 * MS Graph token step — reads same customer SP creds from SM but requests
 * Graph scope (https://graph.microsoft.com/.default) instead of Dataverse scope.
 * Stores result as `graph_token` — used by keep-MS connector steps (Teams/SharePoint/Outlook).
 */
const GRAPH_TOKEN_STEP_SM = `    - get_graph_tenant_id:
        call: http.get
        args:
          url: \${"https://secretmanager.googleapis.com/v1/projects/" + args.gcp_project + "/secrets/studio-enterprise-ms-tenant-id/versions/latest:access"}
          auth:
            type: OAuth2
        result: graph_tenant_resp
    - get_graph_client_id:
        call: http.get
        args:
          url: \${"https://secretmanager.googleapis.com/v1/projects/" + args.gcp_project + "/secrets/studio-enterprise-ms-client-id/versions/latest:access"}
          auth:
            type: OAuth2
        result: graph_client_id_resp
    - get_graph_client_secret:
        call: http.get
        args:
          url: \${"https://secretmanager.googleapis.com/v1/projects/" + args.gcp_project + "/secrets/studio-enterprise-ms-client-secret/versions/latest:access"}
          auth:
            type: OAuth2
        result: graph_client_secret_resp
    - decode_graph_creds:
        assign:
          - graph_tenant_id: \${text.decode(base64.decode(graph_tenant_resp.body.payload.data))}
          - graph_client_id: \${text.decode(base64.decode(graph_client_id_resp.body.payload.data))}
          - graph_client_secret: \${text.decode(base64.decode(graph_client_secret_resp.body.payload.data))}
    - get_graph_token_step:
        call: http.post
        args:
          url: \${"https://login.microsoftonline.com/" + graph_tenant_id + "/oauth2/v2.0/token"}
          headers:
            Content-Type: application/x-www-form-urlencoded
          body: \${"grant_type=client_credentials&client_id=" + graph_client_id + "&client_secret=" + graph_client_secret + "&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default"}
        result: graph_token_response
    - set_graph_token:
        assign:
          - graph_token: \${graph_token_response.body.access_token}`;

const RETURN_COMPLETED = `    - return_result:
        return: "completed"`;

const RETURN_ARGS = `    - return_result:
        return: \${args}`;

// ── Action → YAML step ────────────────────────────────────────────────────────

/**
 * Map one FlowAction to a Cloud Workflows YAML step string.
 * Returns null for action types that produce no YAML (e.g. Scope, which the
 * extractor already flattened into sequential actions).
 */
function mapAction(action: FlowAction, ctx: MappingContext): string | null {
  const sn = uniqueStep(action.name, ctx);

  // ── OpenApiConnection ──────────────────────────────────────────────────────
  if (action.type === 'OpenApiConnection') {
    const connector = action.connector ?? '';

    // Dataverse (both connector names)
    if (
      connector === 'shared_commondataserviceforapps' ||
      connector === 'shared_commondataservice'
    ) {
      const verb = dvHttpVerb(action.operationId);
      const entityPath = dvEntityPath(action);
      const urlExpr = `\${"https://" + args.org_url + "/api/data/v9.2/${entityPath}"}`;
      const dvHeaders = verb === 'get'
        ? [
            `            Authorization: \${"Bearer " + entra_token}`,
            `            OData-MaxVersion: "4.0"`,
            `            OData-Version: "4.0"`,
            `            Accept: application/json`,
          ]
        : [
            `            Authorization: \${"Bearer " + entra_token}`,
            `            OData-MaxVersion: "4.0"`,
            `            OData-Version: "4.0"`,
            `            Accept: application/json`,
            `            Content-Type: application/json`,
          ];
      const bodyLines = (verb === 'post' || verb === 'patch')
        ? [`          body: \${args.${sn}_body}  # TODO: map request body fields`]
        : [];
      return [
        `    - ${sn}:`,
        `        call: http.${verb}`,
        `        args:`,
        `          url: ${urlExpr}`,
        `          headers:`,
        ...dvHeaders,
        ...bodyLines,
        `        result: ${sn}_result`,
      ].join('\n');
    }

    // Teams / SharePoint / OneDrive / Office 365 / Outlook / Azure Blob / Planner / Excel
    // — check customer connector choice; default to 'keep' (MS Graph via entra_token)
    if (
      connector === 'shared_teams' ||
      connector === 'shared_sharepointonline' ||
      connector === 'shared_onedrive' ||
      connector === 'shared_office365' ||
      connector === 'shared_outlook' ||
      connector === 'shared_azureblob' ||
      connector === 'shared_planner' ||
      connector === 'shared_excelonline'
    ) {
      const connectorChoice = ctx.customerAnswers[`connector_${connector}`] ?? 'keep';
      return buildConnectorStep(connector, connectorChoice, sn, action, ctx.customerAnswers);
    }

    // Copilot Studio → Gemini Interactions API (needs agent ID from customer answers)
    if (connector === 'shared_microsoftcopilotstudio') {
      ctx.warnings.push(
        `Action "${action.name}": Copilot Studio connector — map args.gemini_agent_id to the migrated Gemini agent`,
      );
      return [
        `    - ${sn}:`,
        `        # TODO: Replace with the migrated Gemini agent — set args.gemini_agent_id`,
        `        call: http.post`,
        `        args:`,
        `          url: \${"https://dialogflow.googleapis.com/v3/" + args.gemini_agent_id + ":detectIntent"}`,
        `          headers:`,
        `            Authorization: \${"Bearer " + entra_token}`,
        `            Content-Type: application/json`,
        `          body:`,
        `            queryInput:`,
        `              text:`,
        `                text: \${args.user_query}`,
        `        result: ${sn}_result`,
      ].join('\n');
    }

    // Raw HTTP / conversion service → pass-through
    if (connector === 'shared_http' || connector === 'shared_conversionservice') {
      const rawMethod = (action.rawInputs?.method as string | undefined)?.toLowerCase() ?? 'get';
      return [
        `    - ${sn}:`,
        `        call: http.${rawMethod}`,
        `        args:`,
        `          url: \${args.${sn}_url}  # TODO: supply target URL in workflow args`,
        `          headers:`,
        `            Authorization: \${"Bearer " + entra_token}`,
        `        result: ${sn}_result`,
      ].join('\n');
    }

    // Unknown connector — check customer choice (Hermas / stub / keep)
    {
      const connectorChoice = ctx.customerAnswers[`connector_${connector}`];
      if (connectorChoice && connectorChoice !== 'keep') {
        // Customer chose a specific action (e.g. 'hermas' routes via Hermas, 'stub' → stub)
        return buildConnectorStep(connector, connectorChoice, sn, action, ctx.customerAnswers);
      }
      ctx.confidence -= 20;
      ctx.warnings.push(
        `Action "${action.name}": unknown connector "${connector}" — no automatic mapping, add manually`,
      );
      return [
        `    - ${sn}:`,
        `        # TODO: unknown connector "${connector}" — no automatic mapping`,
        `        # Original action: ${action.name}`,
        `        assign:`,
        `          - ${sn}_todo: "Map connector ${connector} manually"`,
      ].join('\n');
    }
  }

  // ── Condition / If ────────────────────────────────────────────────────────
  if (action.type === 'If' || action.type === 'Condition') {
    const trueSn = uniqueStep(`${sn}_true`, ctx);
    const falseSn = uniqueStep(`${sn}_false`, ctx);
    return [
      `    - ${sn}:`,
      `        # Condition (Power Automate If/Condition) — review the expression below`,
      `        switch:`,
      `          - condition: \${true}  # TODO: replace with actual condition expression`,
      `            next: ${trueSn}`,
      `          - condition: true`,
      `            next: ${falseSn}`,
      `    - ${trueSn}:`,
      `        assign:`,
      `          - ${sn}_branch: "true"`,
      `    - ${falseSn}:`,
      `        assign:`,
      `          - ${sn}_branch: "false"`,
    ].join('\n');
  }

  // ── Foreach / Apply_to_each ───────────────────────────────────────────────
  if (action.type === 'Foreach' || action.type === 'Apply_to_each') {
    const rawFor = action.rawInputs?.['foreach'] ?? action.rawInputs?.['items'];
    const iterExpr =
      typeof rawFor === 'string' ? rawFor : `args.${sn}_items`;
    const bodySn = uniqueStep(`${sn}_body`, ctx);
    return [
      `    - ${sn}:`,
      `        # Foreach loop (Power Automate Foreach/Apply_to_each)`,
      `        for:`,
      `          value: ${sn}_item`,
      `          in: \${${iterExpr}}`,
      `          steps:`,
      `            - ${bodySn}:`,
      `                # TODO: add loop body steps here`,
      `                assign:`,
      `                  - ${sn}_processed: \${${sn}_item}`,
    ].join('\n');
  }

  // ── Until ─────────────────────────────────────────────────────────────────
  if (action.type === 'Until') {
    const initSn = uniqueStep(`${sn}_init`, ctx);
    const checkSn = uniqueStep(`${sn}_check`, ctx);
    const bodySn = uniqueStep(`${sn}_body`, ctx);
    return [
      `    - ${initSn}:`,
      `        assign:`,
      `          - ${sn}_counter: 0`,
      `    - ${sn}:`,
      `        # Until loop (Power Automate Until) — review break condition`,
      `        for:`,
      `          value: ${sn}_iteration`,
      `          range: [0, 999]`,
      `          steps:`,
      `            - ${checkSn}:`,
      `                # TODO: replace with actual Until condition`,
      `                switch:`,
      `                  - condition: \${${sn}_iteration >= 100}`,
      `                    next: break`,
      `            - ${bodySn}:`,
      `                # TODO: add loop body steps here`,
      `                assign:`,
      `                  - ${sn}_counter: \${${sn}_counter + 1}`,
    ].join('\n');
  }

  // ── Scope → already flattened by extractor ────────────────────────────────
  if (action.type === 'Scope') {
    // The extractor recurses into Scope and appends child actions to the flat
    // list. No wrapper YAML needed — just skip.
    return null;
  }

  // ── InitializeVariable / SetVariable ─────────────────────────────────────
  if (action.type === 'InitializeVariable' || action.type === 'SetVariable') {
    const inputs = action.rawInputs ?? {};
    // PA stores variables as inputs.variables[0].name / .value for Initialize,
    // and inputs.name / inputs.value for Set.
    const vars = inputs['variables'] as Array<Record<string, unknown>> | undefined;
    const varName = toSnakeCase(
      String(vars?.[0]?.['name'] ?? inputs['name'] ?? 'variable'),
    );
    const rawVal = vars?.[0]?.['value'] ?? inputs['value'] ?? '';
    const valStr = yamlScalar(rawVal);
    return [
      `    - ${sn}:`,
      `        assign:`,
      `          - ${varName}: ${valStr}`,
    ].join('\n');
  }

  // ── AppendToArray / AppendToString ────────────────────────────────────────
  if (
    action.type === 'AppendToArrayVariable' ||
    action.type === 'AppendToStringVariable'
  ) {
    const varName = toSnakeCase(String(action.rawInputs?.['name'] ?? 'variable'));
    const tempVar = uniqueStep(`${sn}_item`, ctx);
    if (action.type === 'AppendToArrayVariable') {
      const concatSn  = uniqueStep(`${sn}_concat`, ctx);
      const initSn    = uniqueStep(`${sn}_init_fallback`, ctx);
      return [
        `    - ${sn}:`,
        `        assign:`,
        `          - ${tempVar}: \${args.${sn}_value}  # TODO: map source expression`,
        `    - ${sn}_try:`,
        `        try:`,
        `          steps:`,
        `            - ${concatSn}:`,
        `                assign:`,
        `                  - ${varName}: \${list.concat(${varName}, [${tempVar}])}`,
        `        except as ${sn}_err:`,
        `          steps:`,
        `            - ${initSn}:`,
        `                assign:`,
        `                  - ${varName}: [\${${tempVar}}]`,
      ].join('\n');
    }
    // AppendToStringVariable
    return [
      `    - ${sn}:`,
      `        assign:`,
      `          - ${tempVar}: \${args.${sn}_value}  # TODO: map source expression`,
      `          - ${varName}: \${"" + ${tempVar}}`,
    ].join('\n');
  }

  // ── Compose ───────────────────────────────────────────────────────────────
  if (action.type === 'Compose') {
    return [
      `    - ${sn}:`,
      `        # Compose — map the expression to a Cloud Workflows expression`,
      `        assign:`,
      `          - ${sn}_output: \${args.${sn}_input}  # TODO: map Compose expression`,
    ].join('\n');
  }

  // ── ParseJson ─────────────────────────────────────────────────────────────
  if (action.type === 'ParseJson') {
    return [
      `    - ${sn}:`,
      `        # ParseJson — Cloud Workflows decodes JSON natively via json.decode`,
      `        assign:`,
      `          - ${sn}_parsed: \${json.decode(args.${sn}_content)}`,
    ].join('\n');
  }

  // ── Response ──────────────────────────────────────────────────────────────
  if (action.type === 'Response') {
    return [
      `    - ${sn}:`,
      `        return: \${args.${sn}_body}  # TODO: map response body expression`,
    ].join('\n');
  }

  // ── Http / Invoke_http ────────────────────────────────────────────────────
  if (action.type === 'Http' || action.type === 'Invoke_http') {
    const verb = (
      (action.rawInputs?.['method'] as string | undefined) ?? 'GET'
    ).toLowerCase();
    return [
      `    - ${sn}:`,
      `        call: http.${verb}`,
      `        args:`,
      `          url: \${args.${sn}_url}  # TODO: supply target URL`,
      `          headers:`,
      `            Authorization: \${"Bearer " + entra_token}`,
      `        result: ${sn}_result`,
    ].join('\n');
  }

  // ── Terminate ─────────────────────────────────────────────────────────────
  if (action.type === 'Terminate') {
    return [
      `    - ${sn}:`,
      `        return: "terminated"`,
    ].join('\n');
  }

  // ── Wait (delay) ──────────────────────────────────────────────────────────
  if (action.type === 'Wait') {
    return [
      `    - ${sn}:`,
      `        call: sys.sleep`,
      `        args:`,
      `          seconds: \${args.${sn}_seconds}  # TODO: set wait duration`,
    ].join('\n');
  }

  // ── Unknown action type ───────────────────────────────────────────────────
  ctx.confidence -= 10;
  ctx.warnings.push(
    `Action "${action.name}" (type "${action.type}"): no automatic mapping — add manually`,
  );
  return [
    `    - ${sn}:`,
    `        # TODO: unknown action type "${action.type}" — no automatic mapping`,
    `        # Original Power Automate action: ${action.name}`,
    `        assign:`,
    `          - ${sn}_todo: "Map action type ${action.type} manually"`,
  ].join('\n');
}

// ── YAML assemblers ───────────────────────────────────────────────────────────

const KEEP_MS_CONNECTORS = new Set([
  'shared_teams', 'shared_sharepointonline', 'shared_onedrive',
  'shared_office365', 'shared_outlook', 'shared_planner', 'shared_excelonline',
]);

function needsGraphToken(flow: FlowIR, customerAnswers: Record<string, string>): boolean {
  return flow.connectors.some((c) => {
    const choice = customerAnswers[`connector_${c.apiName}`] ?? 'keep';
    return KEEP_MS_CONNECTORS.has(c.apiName) && choice === 'keep';
  });
}

function assembleRecurrenceYaml(
  actionSteps: string[],
  useSecretManager = false,
  withGraphToken = false,
): string {
  const tokenStep = useSecretManager ? ENTRA_TOKEN_STEP_SM : ENTRA_TOKEN_STEP;
  return [
    'main:',
    '  params: [args]',
    '  steps:',
    tokenStep,
    ...(withGraphToken ? [GRAPH_TOKEN_STEP_SM] : []),
    ...actionSteps,
    RETURN_COMPLETED,
  ].join('\n');
}

function assembleHttpRequestYaml(
  actionSteps: string[],
  useSecretManager = false,
  withGraphToken = false,
): string {
  const tokenStep = useSecretManager ? ENTRA_TOKEN_STEP_SM : ENTRA_TOKEN_STEP;
  return [
    'main:',
    '  params: [args]',
    '  steps:',
    tokenStep,
    ...(withGraphToken ? [GRAPH_TOKEN_STEP_SM] : []),
    ...actionSteps,
    RETURN_ARGS,
  ].join('\n');
}

function assembleWebhookYaml(
  entity: string | undefined,
  actionSteps: string[],
  useSecretManager = false,
  withGraphToken = false,
): string {
  const entityComment = entity ? `  # Triggered by Dataverse entity: ${entity}` : '';
  const tokenStep = useSecretManager ? ENTRA_TOKEN_STEP_SM : ENTRA_TOKEN_STEP;
  return [
    `main:${entityComment}`,
    '  params: [args]',
    '  steps:',
    '    - parse_event:',
    '        assign:',
    '          - entity_name: ${default(map.get(args, "entity_name"), "unknown")}',
    '          - entity_id: ${default(map.get(args, "entity_id"), "unknown")}',
    '          - event_type: ${default(map.get(args, "event_type"), "created")}',
    tokenStep,
    ...(withGraphToken ? [GRAPH_TOKEN_STEP_SM] : []),
    ...actionSteps,
    RETURN_COMPLETED,
  ].join('\n');
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Map a FlowIR to a Google Cloud Workflow YAML string plus companion configs.
 *
 * @param flow            Normalized Power Automate flow.
 * @param customerAnswers Key/value answers collected from the customer for gaps
 *                        identified during extraction (see FlowGap).
 * @param opts.useSecretManager  When true, the generated YAML reads MS credentials
 *                               from GCP Secret Manager instead of workflow args.
 * @param opts.gcpProject        GCP project ID used in Secret Manager URLs
 *                               (required when useSecretManager is true).
 */
export function mapFlow(
  flow: FlowIR,
  customerAnswers: Record<string, string>,
  opts?: { useSecretManager?: boolean; gcpProject?: string },
): MapperResult {
  const useSecretManager = opts?.useSecretManager ?? false;
  const withGraphToken = useSecretManager && needsGraphToken(flow, customerAnswers);
  // ── Unknown trigger → immediately unsupported ────────────────────────────
  if (flow.trigger.type === 'Unknown') {
    return {
      yaml: '',
      confidence: 0,
      warnings: [`Unsupported trigger type: "${flow.trigger.rawType}"`],
      unsupported: true,
      unsupportedReason: `Unknown trigger type "${flow.trigger.rawType}" — cannot determine how to invoke this flow in Google Cloud Workflows`,
    };
  }

  // ── Map actions ──────────────────────────────────────────────────────────
  const ctx: MappingContext = {
    warnings: [],
    confidence: 100,
    customerAnswers,
    // Pre-register built-in step names so uniqueStep never collides with them
    stepNames: new Set(
      useSecretManager
        ? [
            'get_ms_tenant_id',
            'get_ms_client_id',
            'get_ms_client_secret',
            'get_ms_org_url',
            'decode_ms_secrets',
            'get_entra_token',
            'extract_token',
            'parse_event',
            'return_result',
          ]
        : ['get_entra_token', 'parse_event', 'return_result'],
    ),
  };

  const actionSteps: string[] = [];
  for (const action of flow.actions) {
    try {
      const stepYaml = mapAction(action, ctx);
      if (stepYaml !== null) actionSteps.push(stepYaml);
    } catch (err) {
      ctx.warnings.push(
        `Failed to map action "${action.name}": ${(err as Error).message}`,
      );
    }
  }

  // ── Assemble YAML ────────────────────────────────────────────────────────
  const workflowName = toWorkflowName(flow.name);
  let yaml = '';
  let schedulerConfig: SchedulerConfig | undefined;
  let pubSubConfig: PubSubConfig | undefined;

  if (flow.trigger.type === 'Recurrence') {
    const minutes = flow.trigger.recurrenceMinutes ?? 1440;
    yaml = assembleRecurrenceYaml(actionSteps, useSecretManager, withGraphToken);
    schedulerConfig = {
      jobName: `${workflowName}-scheduler`,
      schedule: minutesToCron(minutes),
      timeZone: customerAnswers['timezone'] ?? 'UTC',
      workflowName,
    };
  } else if (flow.trigger.type === 'HttpRequest' || flow.trigger.type === 'Manual') {
    yaml = assembleHttpRequestYaml(actionSteps, useSecretManager, withGraphToken);
  } else if (flow.trigger.type === 'Webhook') {
    yaml = assembleWebhookYaml(flow.trigger.entity, actionSteps, useSecretManager, withGraphToken);
    const topicName =
      customerAnswers['pubsub_topic'] ??
      `${workflowName}-events`;
    pubSubConfig = {
      topicName,
      workflowName,
    };
  }

  // ── Final confidence ─────────────────────────────────────────────────────
  const finalConfidence = Math.max(0, Math.min(100, ctx.confidence));

  if (finalConfidence < 30) {
    return {
      yaml,
      confidence: finalConfidence,
      warnings: ctx.warnings,
      schedulerConfig,
      pubSubConfig,
      unsupported: true,
      unsupportedReason: `Confidence score ${finalConfidence} is below the minimum threshold of 30 — too many unmapped connectors or actions for reliable automatic migration`,
    };
  }

  return {
    yaml,
    confidence: finalConfidence,
    warnings: ctx.warnings,
    schedulerConfig,
    pubSubConfig,
    unsupported: false,
  };
}
