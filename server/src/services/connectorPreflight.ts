import { logger } from '../logger.js';
import { validateConnectorCredentials, type ConnectorValidationCode } from './connectorValidator.js';
import { getEntraSecret } from './secretManager.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

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
  /** The service account key is fine, but the domain has not authorized its client id
   *  for the scope this connector declares. */
  | 'dwd_scope_not_granted'
  /** The client id could not impersonate this person for ANY scope, so the delegation
   *  itself -- or the person -- is wrong, not one scope string. */
  | 'dwd_not_authorized'
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
 * Can this service account actually be this person, for this scope?
 *
 * The rest of the preflight proves the credential EXISTS and is READABLE. Neither says
 * the customer's Workspace admin authorized its client id for the scope the connector
 * declares -- and domain-wide delegation matches scope strings EXACTLY, so a granted
 * `auth/drive` does nothing for a connector declaring `auth/spreadsheets`.
 *
 * Without this the gap is invisible until someone asks the agent a question: the engine
 * is already built, the tool is wired, and the only symptom is the model apologising.
 * Found live 2026-10-09 -- Google Sheets deployed cleanly, reported 5/5 passed, and every
 * call failed with `unauthorized_client` because `auth/spreadsheets` was never granted
 * while `auth/drive`, `auth/calendar`, `auth/contacts` and `auth/tasks` all were.
 *
 * Returns undefined when the question does not apply (not a Google key, no declared
 * scope, no subject to impersonate) -- an unanswerable check must not become a failure.
 */
async function dwdScopeGranted(
  serviceAccountJson: string,
  scope: string,
  subject: string,
): Promise<{ ok: boolean; clientId?: string; detail?: string } | undefined> {
  let key: { client_email?: string; private_key?: string; client_id?: string };
  try {
    key = JSON.parse(serviceAccountJson) as typeof key;
  } catch {
    return undefined; // not a service-account key; another check owns that
  }
  if (!key.client_email || !key.private_key) return undefined;
  try {
    const { JWT } = await import('google-auth-library');
    const c = new JWT({ email: key.client_email, key: key.private_key, scopes: [scope], subject });
    const { access_token: token } = await c.authorize();
    return token ? { ok: true, clientId: key.client_id } : { ok: false, clientId: key.client_id };
  } catch (e) {
    const m = String((e as Error).message).split(String.fromCharCode(10))[0];
    // Three outcomes, not two. `invalid_grant` means the SUBJECT cannot be resolved at
    // all -- a wrong address or a domain with no Workspace -- which is a different fix
    // from a missing scope, and reporting both as "scope missing" sends people to the
    // wrong console page.
    if (/invalid_grant/i.test(m)) return undefined;
    return { ok: false, clientId: key.client_id, detail: m.slice(0, 160) };
  }
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
  /** The connected admin. Without it the DWD scope check is skipped, not failed. */
  subject?: string,
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
  /** Has this (client id, subject) pair minted ANY scope at all? Proof the grant exists. */
  const grantReachable = new Map<string, boolean>();
  /** Scope failures whose cause is only decidable once every connector has been tried. */
  const deferredScopeFailures: {
    base: { connectorId: string; name: string; secretIds: string[] };
    name: string;
    declaredScope: string;
    clientId?: string;
    subject: string;
    probeKey: string;
  }[] = [];
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

    // DWD SCOPE, before the provider check: a connector whose client id was never
    // authorized for its declared scope cannot authenticate at all, so a provider-side
    // credential probe would report a confusing second-order failure for it.
    //
    // The subject is the identity stored WITH the connector, not the connected admin. The
    // tool mints its token for that person, and a DWD grant is per-DOMAIN: probing an admin
    // who signed in from a different domain reports EVERY scope as missing. Measured
    // 2026-10-09 -- the same key and the same ten scopes read ungranted for one address and
    // granted for another. The connected admin is only the fallback.
    const declaredScope = REGISTRY_BY_ID.get(target.connectorId)?.scope;
    const saJson = values.service_account_json;
    const dwdSubject = values.impersonate_email?.trim() || subject;
    if (saJson && declaredScope && dwdSubject) {
      const grant = await dwdScopeGranted(saJson, declaredScope, dwdSubject);
      if (grant) {
        // Google answers `unauthorized_client` for two different problems: this one scope
        // was never added, and this client id has no delegation in that domain at all. One
        // mint cannot tell them apart, so the verdict waits until the run has tried every
        // connector -- a scope that DID mint for the same (client id, subject) pair is the
        // proof that the delegation itself works and the failure really is per-scope.
        const probeKey = `${grant.clientId ?? ''}|${dwdSubject}`;
        if (grant.ok) {
          grantReachable.set(probeKey, true);
        } else {
          deferredScopeFailures.push({
            base,
            name: target.name,
            declaredScope,
            clientId: grant.clientId,
            subject: dwdSubject,
            probeKey,
          });
          continue;
        }
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

  for (const f of deferredScopeFailures) {
    const delegationWorks = grantReachable.get(f.probeKey) === true;
    const clientId = f.clientId ?? '(see the service account key)';
    results.push(
      delegationWorks
        ? {
            ...f.base,
            ok: false,
            blocker: 'dwd_scope_not_granted',
            detail:
              `${f.name} declares ${f.declaredScope}, but this service account is not ` +
              'authorized for it in your Google Workspace, so every call would fail to ' +
              `authenticate. Other scopes DO work for ${f.subject}, so the delegation ` +
              `itself is fine -- add that EXACT scope string for client id ${clientId} ` +
              'under Admin console -> Security -> API controls -> Domain-wide delegation. ' +
              'Scope strings are matched exactly, so a broader scope you already granted ' +
              'does not cover this one.',
          }
        : {
            ...f.base,
            ok: false,
            blocker: 'dwd_not_authorized',
            detail:
              `${f.name} could not authenticate as ${f.subject}: client id ${clientId} ` +
              'minted no scope at all for that address, so this is the delegation or the ' +
              'address, not one missing scope. Either that user is not in the Workspace ' +
              'where the delegation was authorized (a grant is per-domain), or client id ' +
              `${clientId} has no Domain-wide delegation entry there yet. Check Admin ` +
              `console -> Security -> API controls -> Domain-wide delegation, signed in to ` +
              `${f.subject.split('@')[1] ?? 'that domain'}.`,
          },
    );
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
