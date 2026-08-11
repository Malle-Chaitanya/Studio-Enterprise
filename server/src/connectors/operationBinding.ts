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

/** One operation as distilled by `spikes/_dump_connector_op_index.ts`. */
export interface OpIndexParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'body' | 'formData';
  required: boolean;
  type: string;
  /** Power Apps' own hint. `internal` means the proxy fills it, not the caller. */
  visibility?: string;
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
  },
};

/** A parameter the migrated tool must accept from the model at call time. */
export interface BoundParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'body' | 'formData';
  required: boolean;
  type: string;
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
  | { status: 'proxy-only'; connectorId: string; operationId: string; reason: string };

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
  const binding = VENDOR_BINDINGS[index.connectorId];
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
  if (binding.pathStyle === 'proxy-only') {
    return {
      status: 'proxy-only',
      connectorId: index.connectorId,
      operationId,
      reason: binding.proxyReason ?? 'This connector exposes a Power Platform abstraction, not the vendor API.',
    };
  }

  const vendorPath = stripConnectionId(op.path);
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
    .map((p) => ({ name: p.name, in: p.in, required: p.required, type: p.type }));

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
  /** True when every operation the agent uses can be reproduced. */
  ready: boolean;
}

export function connectorReadiness(index: ConnectorOpIndex, usedOperations: string[]): ConnectorReadiness {
  const bindable: string[] = [];
  const blocked: Array<{ operationId: string; reason: string }> = [];
  for (const opId of usedOperations) {
    const r = bindOperation(index, opId);
    if (r.status === 'bindable') bindable.push(opId);
    else blocked.push({ operationId: opId, reason: r.reason });
  }
  return {
    connectorId: index.connectorId,
    displayName: index.displayName,
    bindable,
    blocked,
    // An agent that uses NO operation of a connector is not "ready" by default — an empty
    // used-list means we failed to read what it calls, which is a gap, not a pass.
    ready: usedOperations.length > 0 && blocked.length === 0,
  };
}
