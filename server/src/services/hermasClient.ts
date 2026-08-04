/**
 * Hermas client — calls the Hermas Cloud Run service from this TypeScript server.
 *
 * Hermas is a separate Python/FastAPI service that uses Claude to:
 *   1. Generate Cloud Workflow YAML from a PA flow JSON
 *   2. Run an agentic fix loop (deploy → test → fix → retry) until the
 *      workflow passes a test execution or hits max retries
 *
 * This file is the only place in the codebase that knows Hermas's URL.
 * Everything else imports from here.
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import type { FlowIR } from '../types.js';
import type { ScannedConnector } from './connectorScanner.js';
import { connectorSecretId, smSecretUrl } from './connectorCredentials.js';

// ── Response shapes (mirrors hermas/server.py Pydantic models) ───────────────

export interface HermasGenerateResult {
  yaml_content: string;
  flow_name: string;
}

export interface HermasMigrateResult {
  flow_name: string;
  success: boolean;
  yaml_content: string;
  attempts: number;
  error: string | null;
  from_cache: boolean;
  flagged_for_human: boolean;
}

export interface HermasBatchResult {
  total: number;
  succeeded: number;
  failed: number;
  flagged: number;
  results: HermasMigrateResult[];
}

// ── Auth header for Cloud Run (IAM-protected) ─────────────────────────────────
// Cloud Run services with --no-allow-unauthenticated require an OIDC token.
// In production our server's service account gets this automatically via
// the metadata server. In local dev we skip auth (Hermas runs unauthenticated).

async function authHeader(): Promise<Record<string, string>> {
  // Local dev: Hermas runs without auth
  if (config.HERMAS_URL.startsWith('http://localhost')) {
    return {};
  }
  // Production: fetch OIDC token from GCE metadata server
  try {
    const audience = config.HERMAS_URL;
    const metaUrl =
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity` +
      `?audience=${encodeURIComponent(audience)}`;
    const res = await fetch(metaUrl, { headers: { 'Metadata-Flavor': 'Google' } });
    if (res.ok) {
      const token = await res.text();
      return { Authorization: `Bearer ${token}` };
    }
  } catch {
    // Not on GCE — fall through
  }
  return {};
}

async function post<T>(path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  const url = `${config.HERMAS_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(await authHeader()),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Hermas ${path} failed (${res.status}): ${detail}`);
  }

  return res.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate Cloud Workflow YAML for a flow — no deploy, no test.
 * Use for preview in Expert mode or when you want YAML only.
 */
export async function generateYaml(
  flow: FlowIR,
  customerAnswers: Record<string, string>,
  opts?: {
    errorContext?: string;
    previousYaml?: string;
    attempt?: number;
    /** Plain-English connector mapping context appended to the Hermas generate prompt. */
    connectorContext?: string;
  },
): Promise<string> {
  logger.info({ flowName: flow.name }, 'hermas: generate YAML');

  const result = await post<HermasGenerateResult>('/generate', {
    flow_json: flow.rawDefinition,
    customer_answers: customerAnswers,
    error_context: opts?.errorContext ?? null,
    previous_yaml: opts?.previousYaml ?? null,
    attempt: opts?.attempt ?? 0,
    connector_context: opts?.connectorContext ?? null,
  });

  return sanitizeYaml(result.yaml_content);
}

function sanitizeYaml(yaml: string): string {
  // Step 1: Reserved step names → prefix with wf_
  let result = yaml
    .replace(/^( {2,4}- )(end|next|return|raise|try|except|parallel|iterate|init)(:)/gm,
      (_m, indent, name, colon) => `${indent}wf_${name}${colon}`,
    )
    .replace(/\bnext: (end|next|return|raise|try|except|parallel|iterate|init)\b/g,
      (_m, name) => `next: wf_${name}`,
    );

  // Step 2: Collapse actual newlines INSIDE ${...} expressions.
  // OpenAI sometimes generates real newlines inside string literals, breaking YAML line parsing.
  result = result.replace(/\$\{[\s\S]*?\}/g, (match) =>
    match.includes('\n') ? match.replace(/\r?\n\s*/g, ' ') : match,
  );

  // Step 3: Fix time.format(x, "format") — invalid in Cloud Workflows (no format-string arg).
  result = result.replace(/\$\{[^}]*time\.format[^}]*\}/g, '${true}');

  // Step 4: Wrap ${...} expression YAML values in YAML single-quotes when they contain
  // `"` (Cloud Workflows string literals) or `: ` (which GCP's YAML parser treats as
  // a mapping key separator, causing "Unterminated expression" errors).
  // GCP's own error message says: "wrap with single quotes (e.g. '${...}')".
  // Inside YAML single-quoted strings, `"` is literal — Cloud Workflows sees it correctly.
  result = result.replace(
    /^(\s+\S[^:\n]*:\s+)(\$\{[^}\n]+\})\s*$/gm,
    (_m, prefix, expr) =>
      (expr.includes('"') || /: /.test(expr)) ? `${prefix}'${expr}'` : `${prefix}${expr}`,
  );

  // Step 5: http.post for exact GET-only MS Graph /me endpoint → http.get
  result = result.replace(
    /call: http\.post(\s+args:\s+url: https:\/\/graph\.microsoft\.com\/v1\.0\/me\s)/g,
    'call: http.get$1',
  );

  return result;
}

/**
 * Full agentic loop — generate → deploy → test → fix → repeat.
 * Returns when the workflow passes a test execution or max retries hit.
 * Timeout: 10 minutes (full fix loop).
 *
 * @param connectorContext  Plain-English connector mapping context built by
 *   buildConnectorPromptContext(). Includes SM URLs for third-party connectors.
 */
export async function migrateFlow(
  flow: FlowIR,
  customerAnswers: Record<string, string>,
  opts?: { connectorContext?: string },
): Promise<HermasMigrateResult> {
  logger.info({ flowName: flow.name }, 'hermas: migrate flow (full loop)');

  return post<HermasMigrateResult>(
    '/migrate',
    {
      flow_json: flow.rawDefinition,
      customer_answers: customerAnswers,
      connector_context: opts?.connectorContext ?? null,
    },
    600_000, // 10 min
  );
}

/**
 * Migrate a batch of flows — all processed sequentially inside Hermas.
 * Use for sending all unknown-strategy flows at once.
 * Timeout: 1 hour (large batches).
 */
export async function migrateFlowBatch(
  flows: FlowIR[],
  customerAnswers: Record<string, string>,
): Promise<HermasBatchResult> {
  logger.info({ count: flows.length }, 'hermas: migrate batch');

  return post<HermasBatchResult>(
    '/migrate/batch',
    {
      flows: flows.map((f) => f.rawDefinition),
      customer_answers: customerAnswers,
    },
    3_600_000, // 1 hour
  );
}

/**
 * Health check — confirm Hermas is reachable before starting a migration.
 * Returns true if healthy, false if unreachable.
 */
export async function isHealthy(): Promise<boolean> {
  try {
    const url = `${config.HERMAS_URL}/health`;
    const headers = await authHeader();
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Connector prompt context ──────────────────────────────────────────────────

/** Google API URL for each known Google replacement option. */
const GOOGLE_API_URLS: Record<string, string> = {
  google_chat: 'https://chat.googleapis.com/v1/spaces/{args.chat_space_id}/messages',
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  google_drive: 'https://www.googleapis.com/drive/v3/files',
  gcs: 'https://storage.googleapis.com/upload/storage/v1/b/{args.gcs_bucket}/o',
  google_tasks: 'https://tasks.googleapis.com/tasks/v1/lists/{args.tasks_list_id}/tasks',
  google_sheets: 'https://sheets.googleapis.com/v4/spreadsheets/{args.sheets_id}/values',
};

/**
 * Build a plain-English connector context block to append to the Hermas generate
 * prompt. Tells Hermas exactly how to handle each connector — what API to call,
 * where credentials live, and how to exchange them.
 */
export function buildConnectorPromptContext(
  connectors: ScannedConnector[],
  customerAnswers: Record<string, string>,
  projectId: string,
): string {
  if (connectors.length === 0) return '';

  const lines: string[] = [
    '=== Connector Context ===',
    'This flow uses the following connectors. Generate YAML accordingly.',
    '',
  ];

  for (const connector of connectors) {
    const { connectorId, displayName, authType, credentialsNeeded } = connector;
    const choice = customerAnswers[`connector_${connectorId}`] ?? 'keep';

    lines.push(`connector: ${connectorId} (${displayName}) — auth: ${authType}`);

    if (authType === 'dataverse') {
      lines.push(
        '  Dataverse — keep MS; use Dataverse OData API with Authorization: Bearer ${entra_token}',
      );
      lines.push('');
      continue;
    }

    if (authType === 'ms-graph') {
      if (choice === 'keep') {
        lines.push('  customer choice: keep (use MS Graph API)');
        lines.push('  auth: Authorization: Bearer ${ms_access_token} (from MS refresh token in SM)');
      } else {
        const apiUrl = GOOGLE_API_URLS[choice] ?? `https://${choice}.googleapis.com/`;
        lines.push(`  customer choice: ${choice}`);
        lines.push(`  use Google ${choice.replace('_', ' ')} API: ${apiUrl}`);
        lines.push('  auth: type: OAuth2 (SA identity, no token needed)');
      }
      lines.push('');
      continue;
    }

    // oauth2 / unknown / other — credentials stored in SM
    if (credentialsNeeded.length > 0) {
      const choiceLabel =
        choice === 'keep' ? 'keep (call original API directly)' : choice;
      lines.push(`  customer choice: ${choiceLabel}`);
      lines.push(
        '  credentials in Secret Manager (use auth: type: OAuth2 to read each):',
      );

      // Align the field labels for readability
      const maxFieldLen = Math.max(...credentialsNeeded.map((f) => f.length));
      for (const field of credentialsNeeded) {
        const secretId = connectorSecretId(connectorId, field);
        const url = smSecretUrl(projectId, secretId);
        const padding = ' '.repeat(maxFieldLen - field.length);
        lines.push(`    ${field}:${padding} ${url}`);
      }

      // Runtime instructions for OAuth2 token exchange
      if (credentialsNeeded.includes('refresh_token')) {
        lines.push('');
        lines.push('  At runtime:');
        lines.push('  1. Read each secret from SM (auth: type: OAuth2 — SA identity)');
        lines.push('  2. Decode with text.decode(base64.decode(...))');
        lines.push(
          '  3. POST to the provider token endpoint with grant_type=refresh_token',
        );
        lines.push('  4. Use the returned access_token for API calls');
      }
    } else {
      lines.push(`  customer choice: ${choice}`);
      lines.push('  no additional credentials needed');
    }

    lines.push('');
  }

  lines.push('=== End Connector Context ===');
  return lines.join('\n');
}
