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
  for (const s of specs) lines.push(`- **${s.name}**`);
  lines.push(
    '',
    'Use a tool whenever the user asks for data or an action in one of these systems, and',
    'prefer it over telling the user to do the task manually. If your indexed knowledge has',
    'no answer, try the relevant tool before saying you do not know. State which system an',
    'answer came from. If a tool returns an error, say so plainly — never invent the result.',
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

/** Fields collected for any MS App Registration connector. */
export const MS_APP_REG_FIELDS = [
  { key: 'tenant_id',     label: 'Tenant ID',     type: 'text'     as const, hint: 'Azure Portal → Azure AD → Properties → Directory (tenant) ID' },
  { key: 'client_id',     label: 'App (Client) ID', type: 'text'   as const, hint: 'Azure Portal → App registrations → your app → Application (client) ID' },
  { key: 'client_secret', label: 'Client Secret',  type: 'password' as const, hint: 'Azure Portal → App registrations → Certificates & secrets → New client secret' },
];

