import { logger } from '../logger.js';
import { validateConnectorCredentials, type ConnectorValidationCode } from './connectorValidator.js';
import { getEntraSecret } from './secretManager.js';

/**
 * Will the DEPLOYED agent actually be able to use its connectors?
 *
 * Everything else in the pipeline answers a different question. `connectorValidator` proves a
 * credential works *from our server*. `grantSecretAccessToServiceAgent` tries to make it
 * readable *from the Reasoning Engine*. Neither one blocks, and a deployed agent resolves its
 * credentials as a THIRD identity — the RE service agent — inside the customer's project. So
 * every existing check can pass, the deploy can report `deployed=true`, and every connector
 * call can still 403 at inference. Measured 2026-08-20: a run logged
 *   "could not grant per-secret access ... connector tools will 403 at inference"
 * and then completed as a success.
 *
 * This module asks the deployed agent's question instead, per connector:
 *
 *   1  is every secret this connector needs actually RECORDED?
 *   2  can the secret VALUE be read back at all (does the version exist)?
 *   3  can the RE SERVICE AGENT read it - the identity that will do so at inference?
 *   4  do the credentials themselves work against the provider?
 *
 * Deliberately connector-AGNOSTIC. There is no per-connector branch here and there must not
 * be one: steps 1-3 are pure Secret Manager mechanics that apply to anything holding a
 * credential, and step 4 delegates to `validateConnectorCredentials`, which keys off the
 * credential GROUP and honestly returns `unverified` for a provider it cannot test. A new
 * connector kind is covered the day it lands in the registry, with no change here.
 *
 * `unverified` is NOT a failure. Refusing to migrate a connector because we cannot test its
 * provider would block the customer over our own missing coverage.
 */

/** Why a connector cannot work, in the order the pipeline would hit it. */
export type PreflightBlocker =
  | 'no_credential_recorded'
  | 'secret_unreadable'
  | 'engine_cannot_read_secret'
  | 'credentials_rejected'
  /** We could not READ the IAM policy, so we cannot say whether the grant is there. */
  | 'grant_unverifiable';

export interface ConnectorPreflight {
  connectorId: string;
  name: string;
  /** False only when a blocker WILL break the connector at inference. */
  ok: boolean;
  blocker?: PreflightBlocker;
  /** Human detail naming the cause and, where possible, the exact fix. */
  detail?: string;
  /** Result of the provider-side credential check, when one ran. */
  validation?: ConnectorValidationCode;
  /** Secrets checked, so a failure names the offending one rather than the whole connector. */
  secretIds: string[];
}

/** The Vertex AI Reasoning Engine service agent for a project - the inference-time reader. */
export function reasoningEngineServiceAgent(projectNumber: string): string {
  return `service-${projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;
}

/**
 * Does `member` hold secretAccessor on this secret?
 *
 * A project-wide grant does not appear in a per-secret policy, so `false` here means "not
 * granted AT THIS LEVEL" - the caller treats a project-level grant as covering it.
 */
async function secretReadableBy(
  saToken: string,
  project: string,
  secretId: string,
  member: string,
): Promise<{ granted: boolean; error?: string }> {
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secretId}:getIamPolicy`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  if (!res.ok) return { granted: false, error: `getIamPolicy ${res.status}` };
  const policy = (await res.json()) as { bindings?: Array<{ role: string; members?: string[] }> };
  const granted = (policy.bindings ?? []).some(
    (b) => b.role === 'roles/secretmanager.secretAccessor' && (b.members ?? []).includes(member),
  );
  return { granted };
}

/** Is secretAccessor held project-wide? One call, reused across every secret. */
/**
 * Is a project-wide `secretAccessor` grant in place for `member`?
 *
 * THREE outcomes, not two. This returned a bare boolean and answered `false` when the policy
 * could not be read at all — so a service account lacking
 * `resourcemanager.projects.getIamPolicy` produced "the engine cannot read these secrets",
 * and the customer was sent to grant a role that was very possibly already there. "I could
 * not check" and "it is not granted" are different facts and only one of them is about the
 * customer; the caller has to be able to tell them apart.
 */
export async function hasProjectWideSecretAccess(
  saToken: string,
  project: string,
  member: string,
): Promise<'granted' | 'absent' | 'unreadable'> {
  const res = await fetch(
    `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  if (!res.ok) {
    logger.warn(
      { project, status: res.status },
      'preflight: project IAM policy unreadable — cannot verify the secret grant either way',
    );
    return 'unreadable';
  }
  const policy = (await res.json()) as { bindings?: Array<{ role: string; members?: string[] }> };
  const granted = (policy.bindings ?? []).some(
    (b) => b.role === 'roles/secretmanager.secretAccessor' && (b.members ?? []).includes(member),
  );
  return granted ? 'granted' : 'absent';
}

export interface PreflightTarget {
  connectorId: string;
  name: string;
  /** field -> secret id, exactly as the deployed tools will resolve them. */
  secretIds: Record<string, string>;
}

/**
 * Run the full check for every connector an agent will wire.
 *
 * Reads secret VALUES because step 4 cannot run without them. They go to the validator and
 * are never logged, returned, or attached to a result - the same rule the rest of the
 * pipeline follows.
 */
export async function preflightConnectors(
  saToken: string,
  project: string,
  projectNumber: string,
  targets: PreflightTarget[],
): Promise<ConnectorPreflight[]> {
  if (targets.length === 0) return [];
  const member = `serviceAccount:${reasoningEngineServiceAgent(projectNumber)}`;
  // Checked once: a project-wide grant makes every per-secret binding unnecessary, and
  // reporting each secret as ungranted when the engine can in fact read them all would send
  // the customer off to fix something that is not broken.
  const projectWideState = await hasProjectWideSecretAccess(saToken, project, member);
  const projectWide = projectWideState === 'granted';
  // Name the project AND the number it resolved to, together, in one line. They are one fact
  // sourced from one lookup, and the only way a mismatch between them ever becomes visible
  // is if something prints both — two projects can share a display name, so reading the id
  // alone out of a log proves nothing about which project was actually checked.
  logger.info({ project, projectNumber, member, projectWide: projectWideState }, 'preflight: secret-grant scope');

  const results: ConnectorPreflight[] = [];
  for (const target of targets) {
    const secretIds = Object.values(target.secretIds ?? {});
    const base = { connectorId: target.connectorId, name: target.name, secretIds };

    if (secretIds.length === 0) {
      results.push({
        ...base,
        ok: false,
        blocker: 'no_credential_recorded',
        detail:
          `No credential is recorded for ${target.name}. Its tools would deploy and then fail ` +
          'on every call. Enter its credentials on the Connectors step first.',
      });
      continue;
    }

    const values: Record<string, string> = {};
    let unreadable: string | undefined;
    for (const [field, secretId] of Object.entries(target.secretIds)) {
      const got = await getEntraSecret(saToken, `projects/${project}/secrets/${secretId}/versions/latest`);
      if (got.ok && got.plaintext) values[field] = got.plaintext;
      else unreadable = secretId;
    }
    if (unreadable) {
      results.push({
        ...base,
        ok: false,
        blocker: 'secret_unreadable',
        detail:
          `The stored credential for ${target.name} could not be read back (${unreadable}). ` +
          'Re-enter it on the Connectors step.',
      });
      continue;
    }

    if (projectWideState === 'unreadable') {
      // Deliberately ok:true. We have no evidence the connector is broken, and reporting a
      // failure we cannot demonstrate would send the customer to fix nothing.
      results.push({
        ...base,
        ok: true,
        blocker: 'grant_unverifiable',
        detail:
          `Could not read the IAM policy on project "${project}", so whether the deployed ` +
          `agent can access ${target.name}'s credentials is unknown. If its calls fail with ` +
          `PERMISSION_DENIED, grant roles/secretmanager.secretAccessor to ` +
          `${reasoningEngineServiceAgent(projectNumber)}.`,
      });
      continue;
    }

    if (!projectWide) {
      const ungranted: string[] = [];
      for (const secretId of secretIds) {
        const { granted } = await secretReadableBy(saToken, project, secretId, member);
        if (!granted) ungranted.push(secretId);
      }
      if (ungranted.length) {
        results.push({
          ...base,
          ok: false,
          blocker: 'engine_cannot_read_secret',
          detail:
            `The deployed agent's identity cannot read ${ungranted.length} of ${secretIds.length} ` +
            `credential(s) for ${target.name}, so every call would fail with PERMISSION_DENIED. ` +
            'The deploy grants this automatically; if it keeps failing, grant it once for the ' +
            `project: roles/secretmanager.secretAccessor to ${reasoningEngineServiceAgent(projectNumber)}.`,
        });
        continue;
      }
    }

    // Provider-side check last: it is the slowest and the only one leaving our network.
    const validation = await validateConnectorCredentials(target.connectorId, values);
    if (validation.code === 'invalid_credentials' || validation.code === 'permission_denied') {
      results.push({
        ...base,
        ok: false,
        blocker: 'credentials_rejected',
        validation: validation.code,
        detail: `${target.name}: ${validation.detail ?? validation.code}`,
      });
      continue;
    }

    // `unverified` and `unreachable` pass. We could not test it, which is not the same as it
    // being broken, and blocking on our own missing coverage would be the worse error.
    results.push({ ...base, ok: true, validation: validation.code });
  }

  const blocked = results.filter((r) => !r.ok);
  if (blocked.length) {
    logger.warn(
      { blocked: blocked.map((b) => `${b.connectorId}:${b.blocker}`) },
      `connector preflight: ${blocked.length} of ${results.length} connector(s) would fail at inference`,
    );
  }
  return results;
}
