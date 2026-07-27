import 'dotenv/config';
import { z } from 'zod';

/**
 * Central, validated configuration. All secrets come from the environment —
 * nothing is hardcoded. In production, populate these from Secret Manager.
 */
const schema = z.object({
  PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ── Persistence (MongoDB) ──────────────────────────────────────────────────
  // Base URI WITHOUT the db name/path (the db name is appended from CSGE_DB).
  // CS_GE uses its own instance — default is a local mongod.
  MONGO_HOST: z.string().default('mongodb://localhost:27017'),
  CSGE_DB: z.string().default('csge'),

  MS_CLIENT_ID: z.string().min(1, 'MS_CLIENT_ID is required'),
  MS_CLIENT_SECRET: z.string().min(1, 'MS_CLIENT_SECRET is required'),
  MS_REDIRECT_URI: z.string().default('http://localhost:8080/callback/microsoft'),

  GOOGLE_CLIENT_ID: z.string().min(1, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:8080/callback/google'),

  GOOGLE_SA_KEY_FILE: z.string().optional(),
  GOOGLE_SA_KEY_JSON: z.string().optional(),
  GEMINI_PROJECT_FALLBACK: z.string().optional(),
  // If set, "Connect Google" skips the browser OAuth and connects via the
  // service account + Domain-Wide Delegation, impersonating this admin. This
  // avoids the Google redirect_uri registration requirement for local/dev runs.
  GOOGLE_IMPERSONATE_EMAIL: z.string().optional(),
  /**
   * Google connect mode:
   *   'oauth'  (default) — REAL per-client path: the client's admin signs in via
   *            OAuth; their email + project drive the run; the SA impersonates
   *            THAT admin (requires their DWD). This is how live clients work.
   *   'bypass' — local/dev shortcut: connect via the SA impersonating
   *            GOOGLE_IMPERSONATE_EMAIL against GEMINI_PROJECT_FALLBACK. No
   *            browser OAuth / redirect-URI registration needed.
   */
  GOOGLE_AUTH_MODE: z.enum(['oauth', 'bypass']).default('oauth'),

  INSTRUCTION_LLM_PROVIDER: z.enum(['gemini', 'anthropic', '']).optional().default(''),
  INSTRUCTION_LLM_API_KEY: z.string().optional(),
  INSTRUCTION_LLM_MODEL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a clear message rather than crashing deep in a request.
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid/missing configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

export const config = parsed.data;

/**
 * Microsoft OAuth scopes for the interactive admin sign-in. `.default` cannot be
 * combined with resource-specific scopes (e.g. dynamics user_impersonation) —
 * Azure rejects that (AADSTS70011). We request Graph `.default` + offline_access.
 *
 * Agent extraction from Dataverse uses APP-ONLY (client_credentials) tokens, not
 * a delegated token — so we do not need (and do not request) delegated Dynamics
 * consent here. Requesting it would trigger AADSTS65001 on the refresh exchange.
 */
export const MS_SCOPES = 'https://graph.microsoft.com/.default offline_access';

/** Google OAuth scopes: cloud-platform for project discovery + identity. */
export const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/cloud-platform openid email profile';

export const SA_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

export const llmEnabled = Boolean(
  config.INSTRUCTION_LLM_PROVIDER && config.INSTRUCTION_LLM_API_KEY,
);
