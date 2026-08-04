/**
 * GCP project provisioning — creates a customer-owned service account in their
 * GCP project and grants it the roles needed to run Cloud Workflows + Secret Manager.
 *
 * CloudFuze's own SA is used only during the setup call; after provisioning the
 * customer SA takes over, and CloudFuze's SA can be removed from the project.
 */

import { config } from '../config.js';
import { getDb } from '../db/core.js';
import { logger } from '../logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SA_NAME = 'studio-enterprise';
const CLOUDFUZE_SA =
  'serviceAccount:studio-enterprise-migration@studio-enterprise-migration.iam.gserviceaccount.com';

const DEFAULT_ROLES: string[] = [
  'roles/workflows.admin',
  'roles/secretmanager.admin',
  'roles/secretmanager.secretAccessor',
  'roles/iam.serviceAccountUser',
  'roles/logging.logWriter',
];

const COLLECTION = 'workflowGcpTokens';
const IAM_BASE = 'https://iam.googleapis.com/v1';
const CRM_BASE = 'https://cloudresourcemanager.googleapis.com/v1';

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ProvisionResult {
  saEmail: string;
  projectId: string;
  rolesGranted: string[];
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

async function gcpFetch(
  token: string,
  url: string,
  method = 'GET',
  body?: unknown,
): Promise<Response> {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function checkOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`GCP ${label} failed (${res.status}): ${text}`);
  }
}

// ── IAM binding types ─────────────────────────────────────────────────────────

interface IamBinding {
  role: string;
  members: string[];
}

interface IamPolicy {
  bindings?: IamBinding[];
  etag?: string;
  version?: number;
}

// ── SA creation ───────────────────────────────────────────────────────────────

/**
 * Create a service account named `studio-enterprise` in the customer's GCP project.
 * Returns the SA email. If the SA already exists (409), returns the email without error.
 */
export async function createCustomerServiceAccount(
  gcpToken: string,
  projectId: string,
): Promise<string> {
  const url = `${IAM_BASE}/projects/${projectId}/serviceAccounts`;
  const saEmail = `${SA_NAME}@${projectId}.iam.gserviceaccount.com`;

  const res = await gcpFetch(gcpToken, url, 'POST', {
    accountId: SA_NAME,
    serviceAccount: {
      displayName: 'Studio Enterprise Workflows SA',
      description: 'Managed by Studio Enterprise — Cloud Workflows runtime account',
    },
  });

  if (res.status === 409) {
    // Already exists — that's fine
    logger.info({ projectId, saEmail }, 'createCustomerServiceAccount: SA already exists');
    return saEmail;
  }

  await checkOk(res, `createServiceAccount for ${projectId}`);
  const json = (await res.json()) as { email?: string };
  const email = json.email ?? saEmail;
  logger.info({ projectId, email }, 'createCustomerServiceAccount: created');
  return email;
}

// ── Project IAM helpers ───────────────────────────────────────────────────────

async function getIamPolicy(gcpToken: string, projectId: string): Promise<IamPolicy> {
  const url = `${CRM_BASE}/projects/${projectId}:getIamPolicy`;
  const res = await gcpFetch(gcpToken, url, 'POST', {});
  await checkOk(res, `getIamPolicy for ${projectId}`);
  return res.json() as Promise<IamPolicy>;
}

async function setIamPolicy(
  gcpToken: string,
  projectId: string,
  policy: IamPolicy,
): Promise<void> {
  const url = `${CRM_BASE}/projects/${projectId}:setIamPolicy`;
  const res = await gcpFetch(gcpToken, url, 'POST', { policy });
  await checkOk(res, `setIamPolicy for ${projectId}`);
}

/**
 * Grant project-level IAM roles to the customer SA.
 * Merges with existing bindings (does not replace the full policy).
 */
export async function grantProjectRoles(
  gcpToken: string,
  projectId: string,
  saEmail: string,
  roles: string[],
): Promise<void> {
  const member = `serviceAccount:${saEmail}`;
  const policy = await getIamPolicy(gcpToken, projectId);
  const bindings: IamBinding[] = policy.bindings ?? [];

  for (const role of roles) {
    const existing = bindings.find((b) => b.role === role);
    if (existing) {
      if (!existing.members.includes(member)) {
        existing.members.push(member);
      }
    } else {
      bindings.push({ role, members: [member] });
    }
  }

  await setIamPolicy(gcpToken, projectId, { ...policy, bindings });
  logger.info({ projectId, saEmail, roles }, 'grantProjectRoles: done');
}

/**
 * Remove a member from all project IAM bindings.
 * Used to remove the CloudFuze SA after setup is complete.
 */
export async function removeProjectMember(
  gcpToken: string,
  projectId: string,
  member: string,
): Promise<void> {
  const policy = await getIamPolicy(gcpToken, projectId);
  const bindings: IamBinding[] = (policy.bindings ?? [])
    .map((b) => ({ ...b, members: b.members.filter((m) => m !== member) }))
    .filter((b) => b.members.length > 0);

  await setIamPolicy(gcpToken, projectId, { ...policy, bindings });
  logger.info({ projectId, member }, 'removeProjectMember: done');
}

// ── MongoDB persistence ───────────────────────────────────────────────────────

async function storeSaEmail(orgId: string, saEmail: string): Promise<void> {
  const db = getDb(config.CSGE_DB);
  await db.collection(COLLECTION).updateOne(
    { orgId },
    { $set: { workflowsSaEmail: saEmail, updatedAt: new Date() } },
    { upsert: true },
  );
  logger.info({ orgId, saEmail }, 'storeSaEmail: persisted to workflowGcpTokens');
}

// ── Top-level orchestrator ────────────────────────────────────────────────────

/**
 * Provision the customer's GCP project:
 *   1. Create the `studio-enterprise` SA in their project
 *   2. Grant it the required project-level IAM roles
 *   3. Persist the SA email to MongoDB `workflowGcpTokens`
 *   4. Optionally remove the CloudFuze SA from the project
 */
export async function provisionCustomerProject(
  gcpToken: string,
  projectId: string,
  orgId: string,
  opts?: { removeCloudFuzeSa?: boolean },
): Promise<ProvisionResult> {
  logger.info({ projectId, orgId }, 'provisionCustomerProject: start');

  const saEmail = await createCustomerServiceAccount(gcpToken, projectId);
  await grantProjectRoles(gcpToken, projectId, saEmail, DEFAULT_ROLES);
  await storeSaEmail(orgId, saEmail);

  if (opts?.removeCloudFuzeSa) {
    try {
      await removeProjectMember(gcpToken, projectId, CLOUDFUZE_SA);
      logger.info({ projectId }, 'provisionCustomerProject: CloudFuze SA removed');
    } catch (err) {
      // Non-fatal — log and continue; SA may not have been present
      logger.warn({ err, projectId }, 'provisionCustomerProject: removeCloudFuzeSa failed (non-fatal)');
    }
  }

  logger.info({ projectId, saEmail }, 'provisionCustomerProject: done');
  return { saEmail, projectId, rolesGranted: DEFAULT_ROLES };
}
