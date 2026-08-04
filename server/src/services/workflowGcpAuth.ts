/**
 * OAuth token lifecycle for Cloud Workflows deployment.
 *
 * Manages per-org GCP OAuth tokens (with auto-refresh) stored in the
 * `workflowGcpTokens` MongoDB collection.
 */

import { config } from '../config.js';
import { getDb } from '../db/core.js';
import { logger } from '../logger.js';

const COLLECTION = 'workflowGcpTokens';

/** Scopes needed to deploy / manage Cloud Workflows and read project info. */
const WORKFLOW_SCOPES = 'https://www.googleapis.com/auth/cloud-platform openid email';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkflowTokens {
  accessToken: string;
  refreshToken: string;
  email: string;
  /** Seconds until the access token expires (from Google's token response). */
  expiresIn: number;
}

interface TokenDoc {
  orgId: string;
  accessToken: string;
  refreshToken: string;
  email: string;
  gcpProjectId?: string;
  /** SA email created in the customer project by provisionCustomerProject(). */
  workflowsSaEmail?: string;
  /** Unix ms when the access token was issued. */
  issuedAt: number;
  /** Token lifetime in seconds as reported by Google. */
  expiresIn: number;
  updatedAt: Date;
}

// ── OAuth URL ─────────────────────────────────────────────────────────────────

/**
 * Build a Google OAuth consent URL for the Cloud Workflows / Cloud Platform scope.
 * `state` is passed through verbatim and returned in the callback — embed whatever
 * context (orgId, CSRF nonce, etc.) you need.
 */
export function buildWorkflowAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    scope: WORKFLOW_SCOPES,
    state,
    access_type: 'offline',
    prompt: 'select_account consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── Code exchange ─────────────────────────────────────────────────────────────

/**
 * Exchange an authorization code for access + refresh tokens, and fetch the
 * signed-in user's email from the Google userinfo endpoint.
 */
export async function exchangeWorkflowCode(code: string): Promise<WorkflowTokens> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.GOOGLE_REDIRECT_URI,
    }),
  });

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !json.access_token) {
    throw new Error(
      `Workflow Google token error (${res.status}): ${json.error_description ?? json.error ?? 'unknown'}`,
    );
  }

  if (!json.refresh_token) {
    throw new Error('Google did not return a refresh_token — ensure access_type=offline and prompt=consent');
  }

  // Fetch email from userinfo
  const email = await fetchUserEmail(json.access_token);

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    email,
    expiresIn: json.expires_in ?? 3600,
  };
}

async function fetchUserEmail(accessToken: string): Promise<string> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return 'unknown';
    const json = (await res.json()) as { email?: string };
    return json.email ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Upsert GCP OAuth tokens for the given org into MongoDB.
 * Overwrites the existing doc if one exists (only one token set per org).
 */
export async function storeWorkflowToken(orgId: string, tokens: WorkflowTokens): Promise<void> {
  const db = getDb(config.CSGE_DB);
  const doc: Omit<TokenDoc, '_id'> = {
    orgId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    email: tokens.email,
    issuedAt: Date.now(),
    expiresIn: tokens.expiresIn,
    updatedAt: new Date(),
  };
  await db.collection<TokenDoc>(COLLECTION).updateOne(
    { orgId },
    { $set: doc },
    { upsert: true },
  );
  logger.info({ orgId, email: tokens.email }, 'Workflow GCP token stored');
}

/**
 * Refresh the access token using the stored refresh_token and persist the new one.
 */
async function refreshAccessToken(orgId: string, doc: TokenDoc): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: doc.refreshToken,
    }),
  });

  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!res.ok || !json.access_token) {
    throw new Error(`Token refresh failed (${res.status}): ${json.error ?? 'unknown'}`);
  }

  // Update DB with the new access token
  const db = getDb(config.CSGE_DB);
  await db.collection<TokenDoc>(COLLECTION).updateOne(
    { orgId },
    {
      $set: {
        accessToken: json.access_token,
        issuedAt: Date.now(),
        expiresIn: json.expires_in ?? 3600,
        updatedAt: new Date(),
      },
    },
  );

  logger.info({ orgId }, 'Workflow GCP token auto-refreshed');
  return json.access_token;
}

/**
 * Return a valid GCP access token for the given org.
 * Auto-refreshes using the stored refresh_token when the token is within 5 minutes
 * of expiry (or already expired).
 *
 * Throws if no token is stored for the org.
 */
export async function getWorkflowGcpToken(orgId: string): Promise<string> {
  const db = getDb(config.CSGE_DB);
  const doc = await db.collection<TokenDoc>(COLLECTION).findOne({ orgId });
  if (!doc) {
    throw new Error(`No GCP token found for org "${orgId}" — complete the OAuth flow first`);
  }

  const ageMs = Date.now() - doc.issuedAt;
  const lifetimeMs = doc.expiresIn * 1000;
  const bufferMs = 5 * 60 * 1000; // 5-minute safety buffer

  if (ageMs < lifetimeMs - bufferMs) {
    return doc.accessToken;
  }

  // Token is expired or near expiry — refresh it
  return refreshAccessToken(orgId, doc);
}

/**
 * Return connection status and metadata for the given org.
 */
export async function getWorkflowTokenStatus(
  orgId: string,
): Promise<{ connected: boolean; email?: string; gcpProjectId?: string }> {
  try {
    const db = getDb(config.CSGE_DB);
    const doc = await db.collection<TokenDoc>(COLLECTION).findOne({ orgId });
    if (!doc) return { connected: false };
    return { connected: true, email: doc.email, gcpProjectId: doc.gcpProjectId };
  } catch (err) {
    logger.warn({ err, orgId }, 'getWorkflowTokenStatus failed');
    return { connected: false };
  }
}

/**
 * Update the gcpProjectId stored for this org (set after the user selects a project).
 */
export async function setWorkflowGcpProject(orgId: string, gcpProjectId: string): Promise<void> {
  const db = getDb(config.CSGE_DB);
  await db.collection<TokenDoc>(COLLECTION).updateOne(
    { orgId },
    { $set: { gcpProjectId, updatedAt: new Date() } },
  );
}

/**
 * Return the Workflows SA email stored for this org, or undefined if not yet provisioned.
 */
export async function getWorkflowSaEmail(orgId: string): Promise<string | undefined> {
  try {
    const db = getDb(config.CSGE_DB);
    const doc = await db.collection<TokenDoc>(COLLECTION).findOne({ orgId });
    return doc?.workflowsSaEmail;
  } catch (err) {
    logger.warn({ err, orgId }, 'getWorkflowSaEmail failed');
    return undefined;
  }
}
