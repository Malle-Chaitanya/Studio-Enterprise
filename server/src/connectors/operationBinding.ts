/**
 * Turn "Copilot called connector X, operation Y" into a real HTTP request we can make from
 * a migrated Gemini agent — or into an honest refusal.
 *
 * WHY THIS EXISTS. A Copilot connector operation resolves, in the Power Apps swagger, to a
 * path like `POST /{connectionId}/crm/v3/objects/companies`. That address is the Power
 * Platform APIM proxy (`usa002-004.azure-apihub.net/apim/<connector>`), and reaching it
 * needs a Power Platform *connection* the migrated agent does not have. So the swagger is
 * not directly callable. What makes it useful is that for many connectors the segment after
 * `{connectionId}` is literally the vendor's own API path — proven live on 2026-08-12
 * (docs/verification-ledger.md §1.11):
 *
 *     shared_hubspotcrm    CompaniesList  GET /{connectionId}/crm/v3/objects/companies
 *     shared_confluence    GetPages       GET /{connectionId}/ex/confluence/{cloudId}/wiki/api/v2/pages
 *     shared_commondata…   ListRecords…   GET /{connectionId}/api/data/v9.1.0/{entityName}
 *
 * Each of those is the vendor's real path. Swap the proxy host for the vendor host and the
 * call is reproducible — mechanically, for every operation of that connector, without a
 * hand-written module per connector.
 *
 * WHERE IT IS NOT TRUE, we say so instead of guessing. Google Drive, OneDrive and Office
 * 365 expose a Microsoft abstraction (`/datasets/default/files/{id}`) that does not exist on
 * the vendor's API, and SharePoint's `HttpRequest` is a tunnel that takes the real request
 * in its body. Those return `unsupported` with the reason, which is what feeds the
 * per-connector "will this migrate without errors?" answer the customer sees BEFORE a run.
 *
 * Pure: no I/O, no config, no network. It reads a captured operation index
 * (`fixtures/<connectorId>.ops.json`) and returns a plan.
 */

/**
 * A JSON shape, resolved from the swagger's `$ref`s so the consumer never has to.
 *
 * Swagger 2.0 keeps body shapes in a separate `definitions` map and points at them with
 * `$ref: '#/definitions/IssueUpdateDetails'`. A consumer handed the raw `$ref` has a
 * pointer into a document it was not given, so every body parameter arrived as the bare
 * word `object` — which is what a model is then asked to invent. Resolving at capture time
 * means the shape travels with the operation and the Python side needs no swagger at all.
 *
 * Bounded on purpose (see MAX_SCHEMA_DEPTH / MAX_SCHEMA_PROPERTIES in captureOpIndex.ts):
 * Jira's issue schema is recursive and would expand without end, and the index is stored in
 * Mongo and shipped into a deployment spec. `truncated` says where a cut was made, so the
 * docstring can admit the shape is partial rather than present a fragment as the whole.
 */
export interface OpIndexSchema {
  type?: string;
  description?: string;
  /** Property names the vendor requires, as the schema itself declares them. */
  required?: string[];
  properties?: Record<string, OpIndexSchema>;
  items?: OpIndexSchema;
  enum?: string[];
  /** Set where depth, breadth or a `$ref` cycle stopped the expansion. Never silent. */
  truncated?: boolean;
}

/** One operation as distilled by `spikes/_dump_connector_op_index.ts`. */
export interface OpIndexParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'body' | 'formData';
  required: boolean;
  type: string;
  /** Power Apps' own hint. `internal` means the proxy fills it, not the caller. */
  visibility?: string;
  /**
   * The vendor's own prose for this parameter.
   *
   * It is the single highest-value field in the index and was being dropped on the floor:
   * a Copilot agent does not store a description per ARGUMENT (only per tool), so without
   * this the model receives a parameter called `$filter` typed `string` and nothing else,
   * and fills it by guessing OData it has never been shown. The swagger has carried the
   * text all along.
   */
  description?: string;
  /** The closed set of values the vendor accepts. Absent means any value of `type`. */
  enum?: string[];
  /**
   * The vendor's documented default when the argument is omitted.
   *
   * REPORTED, never applied. Turning it into the generated Python default would make the
   * migrated tool send a value the source agent did not send — a behaviour change dressed
   * as fidelity. It belongs in the docstring so the model knows what omitting means.
   */
  default?: string | number | boolean;
  /** Resolved shape of a `body` parameter. Only ever set for `in: 'body'`. */
  schema?: OpIndexSchema;
}

export interface OpIndexOperation {
  method: string;
  path: string;
  summary?: string;
  deprecated?: boolean;
  parameters: OpIndexParameter[];
}

export interface ConnectorOpIndex {
  connectorId: string;
  displayName: string;
  proxyHost: string;
  proxyBasePath: string;
  securityDefinitions: Record<string, unknown>;
  connectionAuth: Record<string, { type?: string; identityProvider?: string; resource?: string; scopes?: string[] }>;
  operationCount: number;
  operations: Record<string, OpIndexOperation>;
  /**
   * Binding derived at capture time instead of read from `VENDOR_BINDINGS`.
   *
   * CUSTOM connectors cannot be in a hand-maintained table — they are the customer's own,
   * one per business, named after whatever they typed. But their published definition
   * states the vendor host, base path and credential shape outright, so the entry that
   * would have been hand-written can be derived. Set only when we read a real definition;
   * `undefined` still falls through to the table, so nothing about first-party connectors
   * changes.
   */
  vendorBinding?: VendorBinding;
  /**
   * How many Power Platform POLICIES the connector applies to a request.
   *
   * Policies rewrite the call before it reaches the backend — inject headers, remap query
   * parameters, rewrite the host. We reproduce the swagger, not the policies, so a
   * non-zero count means our call may differ from Copilot's in a way we cannot see. The
   * count travels with the index so the caller can say so rather than assume zero.
   */
  policyCount?: number;
}

/**
 * How a connector's swagger path relates to the vendor's real API.
 *
 * - `vendor-path`  — the path after `{connectionId}` IS the vendor path. Prepend the base.
 * - `proxy-only`   — the path is a Microsoft abstraction with no vendor equivalent. We
 *                    cannot reproduce it from the swagger alone, and say so.
 */
type PathStyle = 'vendor-path' | 'proxy-only';

/** What the migrated tool must present to the vendor. Maps to a credential group we collect. */
export type VendorAuth =
  | 'atlassian-basic' // email + API token, Basic
  | 'bearer-token' // a single secret sent as `Authorization: Bearer …`
  | 'aad-token' // Entra token for a named resource — we already mint these
  | 'google-oauth';

export interface VendorBinding {
  /**
   * Vendor base URL. May contain `{placeholders}` that are NOT swagger parameters but
   * tenant facts (e.g. `{cloudId}` for Atlassian, `{orgUrl}` for Dataverse) — the caller
   * must supply them, and `bindOperation` reports them as `contextRequired`.
   */
  baseUrl: string;
  pathStyle: PathStyle;
  auth: VendorAuth;
  /** Entra resource for `aad-token`. */
  aadResource?: string;
  /**
   * Operation parameters that are TENANT FACTS, not model arguments — an Atlassian
   * `cloudId` is an opaque GUID identifying the customer's site. The swagger cannot tell
   * these apart from real inputs, but a model asked to supply one will invent it, so they
   * are moved out of the tool signature and reported as context the deployer must bind
   * from the stored credentials.
   */
  contextParams?: string[];
  /** Why a `proxy-only` connector cannot be reproduced — shown to the customer verbatim. */
  proxyReason?: string;
  /**
   * Operations on a `proxy-only` connector that ARE reproduced, by a hand-written tool in
   * `server/scripts/connector_tools/`, keyed operationId → what the migrated tool does.
   *
   * `proxy-only` is a per-CONNECTOR verdict, but the reasons are per-operation: some of a
   * connector's dataset abstractions have a clean vendor equivalent and some do not.
   * Without this, an operation we genuinely reproduce is still reported to the customer as
   * "will not be recreated" — understating what migrated, which fails the honesty rule in
   * the same way overstating does.
   *
   * The value is shown verbatim in the readiness report, so it must name any NARROWING
   * (SharePoint tools are scoped to the connected site, the source operation was not).
   */
  customToolOperations?: Record<string, string>;
}

/**
 * The only hand-maintained table in the connector path, and deliberately small: it says
 * WHERE a vendor lives and WHAT credential it wants. Everything else — which operations
 * exist, their verbs, paths and parameters — comes from the captured index.
 *
 * Each entry's `pathStyle` was read off the live swagger, not assumed. Where a connector is
 * absent from this table, `bindOperation` returns `unknown-connector` rather than inventing
 * a base URL: a wrong host produces a tool that fails at run time with a confusing error,
 * which is worse than a clear "not supported yet".
 */
export const VENDOR_BINDINGS: Record<string, VendorBinding> = {
  // `/ex/confluence/{cloudId}/wiki/api/v2/pages` is Atlassian's own path, cloudId and all.
  shared_confluence: {
    baseUrl: 'https://api.atlassian.com',
    pathStyle: 'vendor-path',
    auth: 'atlassian-basic',
    contextParams: ['cloudId'],
  },
  // Jira's swagger drops Atlassian's `/ex/jira/{cloudId}/rest/api` prefix and starts at the
  // API version (`/3/issue/{issueIdOrKey}`), so the prefix lives in the base URL.
  shared_jira: {
    baseUrl: 'https://api.atlassian.com/ex/jira/{cloudId}/rest/api',
    pathStyle: 'vendor-path',
    auth: 'atlassian-basic',
  },
  // `/api/data/v9.1.0/{entityName}` is the Dataverse Web API path we already call during
  // extraction. The base is the customer's own org URL, so it is context, not a constant.
  shared_commondataserviceforapps: {
    baseUrl: '{dataverseOrgUrl}',
    pathStyle: 'vendor-path',
    auth: 'aad-token',
    aadResource: '{dataverseOrgUrl}',
  },
  shared_dynamicscrmonline: {
    baseUrl: '{dataverseOrgUrl}',
    pathStyle: 'vendor-path',
    auth: 'aad-token',
    aadResource: '{dataverseOrgUrl}',
  },
  shared_hubspotcrm: { baseUrl: 'https://api.hubapi.com', pathStyle: 'vendor-path', auth: 'bearer-token' },
  shared_hubspotcrmv2: { baseUrl: 'https://api.hubapi.com', pathStyle: 'vendor-path', auth: 'bearer-token' },
  shared_hubspotsettingsv2: { baseUrl: 'https://api.hubapi.com', pathStyle: 'vendor-path', auth: 'bearer-token' },
  shared_powerplatformadminv2: {
    baseUrl: 'https://api.powerplatform.com',
    pathStyle: 'vendor-path',
    auth: 'aad-token',
    aadResource: 'https://api.powerplatform.com',
  },
  // Google Tasks, and the first Google connector that needs NO Python module of its own.
  //
  // Every other Google app here has a hand-written module in scripts/connector_tools/,
  // because its connector paths are a Power Platform abstraction (Drive 57% dataset-shaped,
  // Sheets 55%). Tasks is not: its captured paths ARE the Tasks v1 API verbatim —
  // `/users/@me/lists`, `/lists/{taskListId}/tasks`, `/lists/{taskListId}/tasks/{taskId}` —
  // so the bound-operation path in connector_tools/generic_rest.py reproduces it with no
  // per-app code. There is deliberately no `if kind == "googletasks"` branch in
  // adk_deploy.py; it falls through to the generic builder, which is the point.
  //
  // Auth needs nothing special either: the registry entry's `google-service-account` already
  // routes through _mint_token's domain-wide-delegation branch, so an invoker agent acts as
  // the caller here exactly as it does on Gmail.
  //
  // Five of its ten operations are polling triggers and are refused per-operation above.
  shared_googletasks: {
    baseUrl: 'https://tasks.googleapis.com/tasks/v1',
    pathStyle: 'vendor-path',
    auth: 'google-oauth',
  },
  // Teams' paths are Graph paths verbatim (`/v1.0/me/joinedTeams`, `/beta/…`).
  shared_teams: {
    baseUrl: 'https://graph.microsoft.com',
    pathStyle: 'vendor-path',
    auth: 'aad-token',
    aadResource: 'https://graph.microsoft.com',
  },
  shared_googledrive: {
    baseUrl: '',
    pathStyle: 'proxy-only',
    auth: 'google-oauth',
    proxyReason:
      "Google Drive's connector paths (/datasets/default/files/{id}) are a Power Platform " +
      'abstraction, not Google Drive API paths. Reproducing these operations needs a ' +
      'hand-written mapping to the Drive v3 API, which this version does not have.',
  },
  shared_onedrive: {
    baseUrl: '',
    pathStyle: 'proxy-only',
    auth: 'aad-token',
    aadResource: 'https://graph.microsoft.com',
    proxyReason:
      "OneDrive's connector paths (/datasets/default/files/{id}) are a Power Platform " +
      'abstraction over Graph, not Graph paths. Reproducing them needs a hand-written ' +
      'mapping to the Graph drive API.',
  },
  shared_office365: {
    baseUrl: '',
    pathStyle: 'proxy-only',
    auth: 'aad-token',
    aadResource: 'https://graph.microsoft.com',
    proxyReason:
      'Office 365 Outlook connector paths are a Power Platform table abstraction ' +
      '(/$metadata.json/datasets/...), not Graph paths.',
  },
  // Every one of this connector's 8 captured operations routes through '/{connectionId}/api/
  // templates/...' or '/{connectionId}/codeless/v1.0/...'. Unlike shared_office365users'
  // codeless operations (which pass through to a genuine Graph path once '{connectionId}/
  // codeless/' is stripped), Word Online's 'api/templates/*' operations are Microsoft's own
  // document-conversion microservice, addressed by a connectionId the customer's app
  // credential cannot obtain — proven live 2026-09-24, a Tier-2 tool built against
  // graph.microsoft.com for GetFilePDF never actually worked.
  shared_wordonlinebusiness: {
    baseUrl: '',
    pathStyle: 'proxy-only',
    auth: 'aad-token',
    aadResource: 'https://graph.microsoft.com',
    proxyReason:
      "Word Online's connector paths ('api/templates/convertFile', 'codeless/v1.0/drives/…') "
      + 'are a Power Automate document-conversion service addressed by a connectionId, not '
      + 'Graph paths — reproducing them needs a hand-written mapping to the Graph drive API.',
    customToolOperations: {
      GetFilePDF:
        "Recreated as `word_online_convert_to_pdf`, using Microsoft Graph's own file-content "
        + 'API (`GET /drive/items/{id}/content?format=pdf`), which performs the identical '
        + 'server-side conversion and accepts the app credential directly — proven live '
        + '2026-09-24 against a real .docx.',
    },
  },
  shared_sharepointonline: {
    baseUrl: '',
    pathStyle: 'proxy-only',
    auth: 'aad-token',
    aadResource: 'https://graph.microsoft.com',
    proxyReason:
      "SharePoint's connector operations are dataset abstractions, and its HttpRequest " +
      'operation is a tunnel that carries the real request in its body — the swagger ' +
      'describes the tunnel, not the call. SharePoint content migrates as knowledge ' +
      '(a data store or the native connector) instead.',
    customToolOperations: {
      // Measured demand: of 340 operations across the three proxy-only Microsoft
      // connectors, this is the only one any staged agent calls (_diag_ms_op_usage.ts,
      // 131 agents, 2026-08-19).
      GetAllTables:
        'Recreated as `sharepoint_list_lists`, which lists the lists and document ' +
        'libraries on the site this agent was connected to. NARROWED: the source ' +
        'operation could target any site the signed-in user could reach; the migrated ' +
        'tool is fixed to the connected site, because our app credential carries ' +
        'Sites.Read.All over the whole tenant.',
    },
  },
};

/**
 * A parameter the migrated tool must accept from the model at call time.
 *
 * The descriptive half (`description`, `enum`, `default`, `schema`) rides along unchanged
 * from the captured index. It never affects WHERE the call goes — only what the model is
 * told it may put in the argument, which is the difference between a tool it can use and
 * one it fills by guessing.
 */
export interface BoundParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'body' | 'formData';
  required: boolean;
  type: string;
  description?: string;
  enum?: string[];
  default?: string | number | boolean;
  schema?: OpIndexSchema;
}

export interface BoundOperation {
  connectorId: string;
  operationId: string;
  method: string;
  /** Full URL template: vendor base + vendor path, `{placeholders}` intact. */
  urlTemplate: string;
  parameters: BoundParameter[];
  auth: VendorAuth;
  aadResource?: string;
  /**
   * Placeholders in the URL that are NOT operation parameters — tenant facts the deployer
   * must supply (`cloudId`, `dataverseOrgUrl`). Empty means the operation is callable with
   * nothing but the model's arguments and a credential.
   */
  contextRequired: string[];
}

export type BindingResult =
  | { status: 'bindable'; operation: BoundOperation }
  | { status: 'unknown-connector'; connectorId: string; reason: string }
  | { status: 'unknown-operation'; connectorId: string; operationId: string; reason: string }
  | { status: 'proxy-only'; connectorId: string; operationId: string; reason: string }
  | { status: 'custom-tool'; connectorId: string; operationId: string; reason: string };

/** `{connectionId}` is filled by the proxy, never by us — it is not part of a vendor call. */
function stripConnectionId(path: string): string {
  return path.replace(/^\/\{connectionId\}/, '');
}

/** Placeholders in a template that no operation parameter supplies. */
function contextPlaceholders(template: string, params: OpIndexParameter[]): string[] {
  const names = new Set(params.map((p) => p.name));
  const found = new Set<string>();
  for (const m of template.matchAll(/\{([^}]+)\}/g)) {
    const name = m[1];
    if (!names.has(name)) found.add(name);
  }
  return [...found];
}

/**
 * Resolve one operation against its connector's captured index.
 *
 * Every failure mode is named rather than thrown: the caller needs to REPORT why an
 * operation will not migrate, per operation, before the run starts.
 */
export function bindOperation(index: ConnectorOpIndex, operationId: string): BindingResult {
  // A binding derived from the connector's own published definition outranks the table:
  // it came from the customer's actual environment, and for a custom connector there is no
  // table entry to outrank.
  const binding = index.vendorBinding ?? VENDOR_BINDINGS[index.connectorId];
  if (!binding) {
    return {
      status: 'unknown-connector',
      connectorId: index.connectorId,
      reason:
        `No vendor binding for ${index.connectorId}. Its operations resolve in the Power ` +
        'Platform swagger, but we do not know which vendor host and credential they map to, ' +
        'so a tool built from them would fail at run time.',
    };
  }
  const op = index.operations[operationId];
  if (!op) {
    return {
      status: 'unknown-operation',
      connectorId: index.connectorId,
      operationId,
      reason:
        `Operation ${operationId} is not in the captured index for ${index.connectorId} ` +
        `(${index.operationCount} operations). The connector may have changed, or the agent ` +
        'may call an operation from a newer version than the one captured.',
    };
  }
  // A hand-written tool outranks the connector-level proxy-only verdict: we reproduce this
  // specific operation even though the connector as a whole has no generic mapping.
  const customTool = binding.customToolOperations?.[operationId];
  if (customTool) {
    return {
      status: 'custom-tool',
      connectorId: index.connectorId,
      operationId,
      reason: customTool,
    };
  }

  if (binding.pathStyle === 'proxy-only') {
    return {
      status: 'proxy-only',
      connectorId: index.connectorId,
      operationId,
      reason: binding.proxyReason ?? 'This connector exposes a Power Platform abstraction, not the vendor API.',
    };
  }

  const vendorPath = stripConnectionId(op.path);

  // A `/trigger<n>/` segment is Power Platform's POLLING-TRIGGER wrapper, not a vendor path.
  // Measured on shared_googletasks, whose ten operations split exactly in half: five actions
  // sit on real Google Tasks paths (`/users/@me/lists`, `/lists/{taskListId}/tasks`) and five
  // triggers sit on `/trigger1/users/@me/lists` … `/trigger5/…`. The vendor has no such route,
  // so binding one yields `https://tasks.googleapis.com/tasks/v1/trigger1/users/@me/lists`,
  // which 404s at run time with an error no customer could trace back to us.
  //
  // This connector is still `vendor-path` and that verdict is right — it means the CONNECTOR's
  // paths are the vendor's, never that every operation on it is bindable. Refused per
  // operation rather than per connector, so the five real actions still bind. Reported as
  // `proxy-only` because that is literally what it is: a Power Platform wrapper with no
  // vendor route underneath, and every consumer already renders that verdict honestly.
  const trigger = /^\/trigger\d*\//i.exec(vendorPath);
  if (trigger) {
    return {
      status: 'proxy-only',
      connectorId: index.connectorId,
      operationId,
      reason:
        `${operationId} is a Power Platform polling trigger (its path begins ` +
        `\`${trigger[0]}\`), not a vendor API call. A migrated agent calls tools on demand ` +
        'and does not poll, so there is nothing on the vendor side to bind it to.',
    };
  }

  const urlTemplate = `${binding.baseUrl.replace(/\/$/, '')}${vendorPath}`;
  // `x-ms-visibility: internal` parameters are the proxy's own plumbing (connectionId,
  // the fixed `prefer`/`accept` headers). Passing them through would make the tool
  // signature meaningless to the model, so they are dropped — except where they are
  // genuinely required by the vendor, which the caller supplies as a fixed header.
  const contextParams = new Set(binding.contextParams ?? []);
  const parameters: BoundParameter[] = op.parameters
    .filter((p) => p.name !== 'connectionId')
    .filter((p) => p.visibility !== 'internal')
    .filter((p) => !contextParams.has(p.name))
    .map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      type: p.type,
      // Carried through rather than re-derived. The index is the one place these are read
      // from the swagger; a second reading here is the duplicated-fact bug this codebase
      // keeps paying for.
      description: p.description,
      enum: p.enum,
      default: p.default,
      schema: p.schema,
    }));

  // Anything the model no longer supplies has to be supplied by us, so both kinds of
  // placeholder — unknown to the swagger, or known but tenant-scoped — are reported here.
  const context = [
    ...contextPlaceholders(urlTemplate, op.parameters),
    ...op.parameters.filter((p) => contextParams.has(p.name)).map((p) => p.name),
  ];

  return {
    status: 'bindable',
    operation: {
      connectorId: index.connectorId,
      operationId,
      method: op.method,
      urlTemplate,
      parameters,
      auth: binding.auth,
      aadResource: binding.aadResource,
      contextRequired: [...new Set(context)],
    },
  };
}

/** Per-connector readiness, for the "will this migrate without errors?" answer. */
export interface ConnectorReadiness {
  connectorId: string;
  displayName: string;
  bindable: string[];
  blocked: Array<{ operationId: string; reason: string }>;
  /**
   * Operations reproduced by a hand-written tool rather than a generic binding. They count
   * as ready, but each carries a note describing what the migrated tool does — and, where
   * relevant, what it narrows. The caller must surface these: they are the difference
   * between "migrated" and "migrated exactly".
   */
  customTool: Array<{ operationId: string; note: string }>;
  /** True when every operation the agent uses can be reproduced. */
  ready: boolean;
}

export function connectorReadiness(index: ConnectorOpIndex, usedOperations: string[]): ConnectorReadiness {
  const bindable: string[] = [];
  const blocked: Array<{ operationId: string; reason: string }> = [];
  const customTool: Array<{ operationId: string; note: string }> = [];
  for (const opId of usedOperations) {
    const r = bindOperation(index, opId);
    if (r.status === 'bindable') bindable.push(opId);
    else if (r.status === 'custom-tool') {
      bindable.push(opId);
      customTool.push({ operationId: opId, note: r.reason });
    } else blocked.push({ operationId: opId, reason: r.reason });
  }
  return {
    connectorId: index.connectorId,
    displayName: index.displayName,
    bindable,
    blocked,
    customTool,
    // An agent that uses NO operation of a connector is not "ready" by default — an empty
    // used-list means we failed to read what it calls, which is a gap, not a pass.
    ready: usedOperations.length > 0 && blocked.length === 0,
  };
}
