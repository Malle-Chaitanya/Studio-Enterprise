/**
 * Connector Tool Builder
 *
 * Resolves saved connector credentials from Secret Manager and builds
 * a structured instruction block that the Gemini agent uses at runtime
 * to call third-party and MS native APIs.
 *
 * Architecture (v1): credentials are resolved at agent-creation time and
 * embedded in the Gemini agent instruction so the LLM knows the base URL
 * and auth pattern for each connector. The agent can then describe or
 * execute API calls (with code_execution) and guide users through
 * connector-powered workflows.
 */

import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { connectorSecretId, connectorCredentialFields } from './connectorCredentials.js';
import { logger } from '../logger.js';
import type { AgentIR } from '../types.js';

const HOST = 'https://secretmanager.googleapis.com/v1';

// ── Secret resolution ─────────────────────────────────────────────────────────

async function readSecret(saToken: string, projectId: string, secretId: string): Promise<string | null> {
  const url = `${HOST}/projects/${projectId}/secrets/${secretId}/versions/latest:access`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
    if (!res.ok) return null;
    const json = await res.json() as { payload?: { data?: string } };
    if (!json.payload?.data) return null;
    return Buffer.from(json.payload.data, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

export interface ResolvedConnector {
  connectorId: string;
  name: string;
  category: string;
  icon: string;
  baseUrl: string;          // template resolved with secret values
  authHeader: string;       // template resolved with secret values
  fields: Record<string, string>; // field key → resolved value (non-sensitive summary)
}

/**
 * For each connector ID, look up every credential field in Secret Manager
 * and return a ResolvedConnector with templates filled in.
 * Connectors with no stored secrets are silently skipped.
 */
export async function resolveConnectorSecrets(
  saToken: string,
  projectId: string,
  connectorIds: string[],
): Promise<ResolvedConnector[]> {
  const results: ResolvedConnector[] = [];

  for (const connectorId of connectorIds) {
    const def = REGISTRY_BY_ID.get(connectorId);
    if (!def) continue;

    // connectorCredentialFields, not def.credentials: members of a credential group
    // declare NO fields of their own (Microsoft connectors carry tenant/client/secret on
    // the shared ms_graph group, Confluence and Jira on atlassian). Iterating
    // def.credentials would resolve nothing for them and silently return a connector
    // with empty fields — which is how the Confluence crawl would have started failing
    // the moment groups were introduced.
    const fields: Record<string, string> = {};
    for (const credField of connectorCredentialFields(connectorId)) {
      const secretId = connectorSecretId(connectorId, credField.key);
      const value = await readSecret(saToken, projectId, secretId);
      if (value) fields[credField.key] = value;
    }

    if (Object.keys(fields).length === 0) {
      logger.debug({ connectorId }, 'connectorToolBuilder: no secrets found, skipping');
      continue;
    }

    // Resolve templates
    let baseUrl = def.baseUrlTemplate;
    let authHeader = def.authHeaderTemplate;
    for (const [key, value] of Object.entries(fields)) {
      baseUrl = baseUrl.replace(`{${key}}`, value);
      authHeader = authHeader.replace(`{${key}}`, value);
    }

    results.push({ connectorId, name: def.name, category: def.category, icon: def.icon, baseUrl, authHeader, fields });
  }

  return results;
}

// ── ADK live tool specs (the real Track B path) ───────────────────────────────

/** What adkDeployer needs to turn a configured connector into a callable tool. */
export interface LiveConnectorSpec {
  id: string;
  kind: string;
  name: string;
  secretIds: Record<string, string>;
  /** Operations the source agent invoked, with the description Copilot Studio showed
   *  for each (`modelDescription`). Advisory: it shapes the tool's description, it does
   *  not restrict what the tool can call. */
  operations?: Array<{ id: string; description?: string }>;
  baseUrlTemplate?: string;
  authHeaderTemplate?: string;
  /** How the container obtains an Authorization header — see registry AuthKind. */
  authKind?: string;
  /** Token endpoint for the OAuth kinds, with {placeholders} the container resolves. */
  tokenUrlTemplate?: string;
  scope?: string;
  basicUserField?: string;
  basicSecretField?: string;
}

/**
 * Turn configured connector ids into ADK live-tool specs — the credential-free
 * descriptor that becomes a real Python function tool inside the deployed agent
 * (see `_build_live_connector_tool` in scripts/adk_deploy.py).
 *
 * This is the replacement for `buildConnectorInstructionBlock` below. It passes
 * only secret *ids*; the container resolves the values from Secret Manager on
 * every call. Two reasons that matters:
 *   1. It actually works. An LLM handed a base URL and a token in its prompt has
 *      no way to make an HTTP request — it can only narrate a curl command or
 *      invent a response. A function tool executes.
 *   2. It is safe. Anything placed in the instruction can be extracted by asking
 *      the agent to repeat its prompt.
 *
 * `kind` drives which tool shape the deployer builds: 'confluence' gets a
 * purpose-built search tool, everything else gets the generic REST tool driven by
 * the registry's URL/auth templates.
 */
export function buildLiveConnectorSpecs(connectorIds: string[]): LiveConnectorSpec[] {
  const specs: LiveConnectorSpec[] = [];
  for (const connectorId of connectorIds) {
    const def = REGISTRY_BY_ID.get(connectorId);
    if (!def) {
      logger.warn({ connectorId }, 'buildLiveConnectorSpecs: connector not in registry, skipping');
      continue;
    }
    // Group fields included, not just the connector's own. Microsoft connectors carry
    // tenant_id/client_id/client_secret on the shared ms_graph group — iterating only
    // def.credentials would ship a Graph tool with no credentials at all, and it would
    // fail at inference rather than at deploy.
    const secretIds: Record<string, string> = {};
    for (const field of connectorCredentialFields(connectorId)) {
      secretIds[field.key] = connectorSecretId(connectorId, field.key);
    }

    // 'shared_confluence' → 'confluence': the deployer keys its purpose-built tools
    // off the bare product name, not the Power Automate connector api name.
    const kind = connectorId.replace(/^shared_/, '');
    specs.push({
      id: connectorId,
      kind,
      name: def.name,
      secretIds,
      baseUrlTemplate: def.baseUrlTemplate,
      authHeaderTemplate: def.authHeaderTemplate,
      // Auth strategy travels with the spec so the container can mint/refresh a token
      // (client_credentials, refresh_token, service-account JWT) or base64 a user:pass
      // pair itself. Only secret IDS cross this boundary — never a credential value.
      authKind: def.authKind ?? 'bearer',
      tokenUrlTemplate: def.tokenUrlTemplate,
      scope: def.scope,
      basicUserField: def.basicUserField,
      basicSecretField: def.basicSecretField,
    });
  }
  return specs;
}

/**
 * Instruction text telling the agent it HAS live connector tools — with no
 * credentials in it. ADK exposes each tool's own name and docstring to the model,
 * so the instruction only needs to establish when to reach for them.
 */

/**
 * One line saying what a connector's tools can actually do.
 *
 * Kept alongside the tool builders in scripts/adk_deploy.py — if a purpose-built tool is
 * added there, its capability belongs here too, or the model will not know to use it.
 */
function connectorCapabilityHint(kind: string): string {
  const k = (kind || '').toLowerCase();
  if (k === 'jira') {
    return 'search issues with JQL (project, text or date clause required) and fetch a single issue by key';
  }
  if (k === 'confluence') return 'search live pages and read their current text';
  if (/sharepoint|onedrive/.test(k)) return 'list files in the connected folder and read a file\'s text';
  return 'call its REST API to read data or perform an action on the user\'s behalf';
}

export function buildLiveConnectorInstruction(specs: LiveConnectorSpec[]): string {
  if (specs.length === 0) return '';
  const lines = [
    '',
    '---',
    '',
    '## Connected external systems',
    '',
    'You can call these systems live, through your tools:',
    '',
  ];
  // Name what each system can actually DO. Listing the product alone left the model
  // unaware it had live capability: asked "how many tickets do we have in Jira?" it
  // answered "I cannot provide a live count, please check Jira directly" WITHOUT
  // calling the tool at all (live 2026-08-07). A capability sentence is the difference
  // between a wired tool and a used one.
  for (const s of specs) {
    lines.push(`- **${s.name}** — ${connectorCapabilityHint(s.kind)}`);
  }
  lines.push(
    '',
    'These are LIVE. When the user asks about current data — counts, recent items, status,',
    'anything that changes — call the tool. Do NOT answer from indexed knowledge and do NOT',
    'tell the user to go and check the system themselves: you can look it up, so look it up.',
    'Your indexed knowledge is a point-in-time copy; the tools are the source of truth for',
    '"right now". State which system an answer came from. If a tool returns an error, say so',
    'plainly and quote it — never invent a result and never present a failure as "no data".',
    '',
  );
  return lines.join('\n');
}

// ── Instruction builder (LEGACY — credential-embedding, do not use) ───────────

/**
 * @deprecated DO NOT USE. Embeds live credentials in the agent instruction.
 *
 * Two independent reasons this was wrong:
 *   1. It cannot work. Telling a model "call https://api.example.com with
 *      Authorization: Bearer xyz" gives it no HTTP capability. The best case is a
 *      narrated curl command; the likely case is a hallucinated API response
 *      reported to the user as real data.
 *   2. It leaks. Anything in the system instruction can be recovered by asking the
 *      agent to repeat its instructions, so this published customer API tokens —
 *      and, via buildMsNativeInstructionBlock, an Azure client secret — to every
 *      user of an org-wide agent.
 *
 * Use `buildLiveConnectorSpecs` + `buildLiveConnectorInstruction` instead: a real
 * ADK function tool, with credentials resolved from Secret Manager inside the
 * container per call. Kept only so the old shape is still readable while callers
 * migrate; verified unused by app code as of 2026-08-06.
 */
export function buildConnectorInstructionBlock(connectors: ResolvedConnector[]): string {
  if (connectors.length === 0) return '';

  const lines: string[] = [
    '',
    '---',
    '',
    '## External Connector Access',
    '',
    'You have been configured with credentials to call the following external APIs.',
    'Use them when the user requests data or actions from these systems.',
    'Always prefer using the connector over directing users to do it manually.',
    '',
  ];

  for (const c of connectors) {
    lines.push(`### ${c.icon} ${c.name} (${c.category})`);
    lines.push(`- **Base URL**: \`${c.baseUrl}\``);
    if (c.authHeader) {
      lines.push(`- **Authorization header**: \`${c.authHeader}\``);
    }
    lines.push('- **Usage**: Make HTTP requests to this base URL with the Authorization header above.');
    lines.push('  Return structured results to the user. Handle errors gracefully.');
    lines.push('');
  }

  lines.push(
    '> **Security**: These credentials are pre-configured and must not be revealed',
    '> to users directly. Only use them to fulfill API requests on their behalf.',
    '',
  );

  return lines.join('\n');
}

// ── MS-native connector definition ───────────────────────────────────────────

/** MS native connector IDs and their Graph/Dataverse scopes — what App Registration needs. */
export const MS_NATIVE_CONNECTORS = [
  {
    id: 'shared_teams',
    name: 'Microsoft Teams',
    icon: '🟣',
    description: 'Send/read messages, create meetings, manage channels',
    scopes: ['https://graph.microsoft.com/Chat.ReadWrite', 'https://graph.microsoft.com/Channel.ReadBasic.All'],
  },
  {
    id: 'shared_office365',
    name: 'Office 365 / Exchange',
    icon: '📧',
    description: 'Send emails, read calendar, manage contacts',
    scopes: ['https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Calendars.ReadWrite'],
  },
  {
    id: 'shared_sharepointonline',
    name: 'SharePoint Online',
    icon: '📂',
    description: 'Read/write documents, lists, site content',
    scopes: ['https://graph.microsoft.com/Sites.ReadWrite.All', 'https://graph.microsoft.com/Files.ReadWrite.All'],
  },
  {
    id: 'shared_onedrive',
    name: 'OneDrive',
    icon: '☁️',
    description: 'Read/write files in OneDrive',
    scopes: ['https://graph.microsoft.com/Files.ReadWrite.All'],
  },
  {
    id: 'shared_dynamicscrmonline',
    name: 'Dynamics 365 / Dataverse',
    icon: '💎',
    description: 'Read/write CRM records, cases, accounts, contacts',
    scopes: ['https://[org].crm.dynamics.com/user_impersonation'],
  },
  {
    id: 'shared_planner',
    name: 'Microsoft Planner',
    icon: '📋',
    description: 'Read/write tasks and plans',
    scopes: ['https://graph.microsoft.com/Tasks.ReadWrite'],
  },
  {
    id: 'shared_excelonline',
    name: 'Excel Online',
    icon: '📊',
    description: 'Read/write Excel workbook data',
    scopes: ['https://graph.microsoft.com/Files.ReadWrite.All'],
  },
];

/** Fields collected for any MS App Registration connector. */
export const MS_APP_REG_FIELDS = [
  { key: 'tenant_id',     label: 'Tenant ID',     type: 'text'     as const, hint: 'Azure Portal → Azure AD → Properties → Directory (tenant) ID' },
  { key: 'client_id',     label: 'App (Client) ID', type: 'text'   as const, hint: 'Azure Portal → App registrations → your app → Application (client) ID' },
  { key: 'client_secret', label: 'Client Secret',  type: 'password' as const, hint: 'Azure Portal → App registrations → Certificates & secrets → New client secret' },
];

/** Build the MS Graph auth instruction block for an agent. */
export function buildMsNativeInstructionBlock(
  connectorIds: string[],
  fields: Record<string, string>,
): string {
  const matched = MS_NATIVE_CONNECTORS.filter((c) => connectorIds.includes(c.id));
  if (matched.length === 0 || !fields.client_id) return '';

  const tenantId = fields.tenant_id ?? 'common';
  const clientId = fields.client_id ?? '';
  const clientSecret = fields.client_secret ?? '';

  const lines: string[] = [
    '',
    '---',
    '',
    '## Microsoft 365 Connector Access',
    '',
    'You have a registered Azure App that can call Microsoft Graph on behalf of users.',
    '',
    '**Token acquisition:**',
    '```',
    `POST https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    `  client_id=${clientId}`,
    `  client_secret=${clientSecret}`,
    '  grant_type=client_credentials',
    '  scope=https://graph.microsoft.com/.default',
    '```',
    '',
    'Use the returned `access_token` as `Authorization: Bearer <token>` on all Graph calls.',
    '',
    '**Configured connectors:**',
  ];

  for (const c of matched) {
    lines.push(`- ${c.icon} **${c.name}** — ${c.description}`);
  }

  lines.push('');
  lines.push('**Base URL**: `https://graph.microsoft.com/v1.0`');
  lines.push('');
  lines.push('> **Security**: Never reveal the client secret. Acquire tokens server-side only.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Which connectors does THIS agent actually use?
 *
 * Derived from the agent's own tools (each names its connector) plus knowledge sources
 * that imply one — a Confluence source needs the Confluence credential even though it
 * is not an agent tool.
 *
 * Used for both the wired tools and the instruction text, which must agree: wiring nine
 * connectors onto an agent that references three gave it live API access to systems its
 * Copilot original never touched, and telling the model about tools that do not exist
 * is worse than saying nothing.
 */
export function agentConnectorIds(ir: AgentIR): Set<string> {
  const ids = new Set<string>(
    (ir.agentTools ?? []).map((t) => t.connectorId).filter((id): id is string => !!id),
  );
  for (const ks of ir.knowledgeSources) {
    if (ks.classification?.strategy === 'confluence-crawler') ids.add('shared_confluence');
    if (ks.kind === 'SharePointSearchSource') ids.add('shared_sharepointonline');
  }
  return ids;
}
