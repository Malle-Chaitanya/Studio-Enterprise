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
  /**
   * CloudFuze's OWN GCP project (never a customer's) where per-tenant Entra
   * app credentials are stored in Secret Manager — see services/secretManager.ts
   * and .claude/memory/decisions.md (2026-08-03). When unset, connector setup
   * simply skips the reuse-across-sites optimization and always asks the admin
   * for credentials (graceful degrade, not a hard failure).
   */
  CLOUDFUZE_GCP_PROJECT: z.string().optional(),
  /**
   * Optional HARD allowlist limiting which accounts the service account may
   * impersonate via Domain-Wide Delegation. Comma-separated; each entry is an
   * exact email (`admin@acme.com`) or a domain (`acme.com` / `@acme.com`). When
   * set, any impersonation target outside the list is refused (fail closed) — the
   * primary guard against the SA's domain-wide power being turned on the wrong
   * user. Leave empty for multi-tenant SaaS, where the target is still constrained
   * at the call site to the session's OAuth-authenticated admin (never client input).
   */
  GOOGLE_DWD_ALLOWED_IMPERSONATORS: z.string().optional(),

  INSTRUCTION_LLM_PROVIDER: z.enum(['gemini', 'anthropic', '']).optional().default(''),
  INSTRUCTION_LLM_API_KEY: z.string().optional(),
  INSTRUCTION_LLM_MODEL: z.string().optional(),

  // ── Hermas workflow migration agent ───────────────────────────────────────
  // URL of the Hermas Cloud Run service. Local dev: http://localhost:8001
  // Production: https://hermas-xxxx-uc.a.run.app (set after deploying)
  HERMAS_URL: z.string().default('http://localhost:8001'),
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
