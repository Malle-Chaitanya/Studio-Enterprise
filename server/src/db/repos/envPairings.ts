import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * WHICH Gemini app each source environment was pointed at — the customer's own choice.
 *
 * WHY THIS EXISTS: the pairing lived only in the browser. `pair.save` wrote
 * `csge_dest_<session>` to sessionStorage and nothing sent it to the server, so the
 * server never learned what was chosen. The credential routes meanwhile resolved their
 * project from `session.geminiProject` — the one `discoverGeminiProject` picked by itself
 * at Google connect. Two notions of "where this migration goes" that never met: an admin
 * selected one project and their secrets were written to another, which surfaced as
 * "Secret Manager API is not enabled on project X" naming a project they had never
 * chosen. Measured 2026-10-14.
 *
 * Keyed by appUserId + tenantId + envUrl, NOT by session. A pairing is a decision about a
 * customer's environment, not a property of the browser tab it was made in — it has to
 * survive the session TTL, a reload, and a different machine, the same way
 * `connectorCredentials` and `identityMappings` already do.
 *
 * tenantId is part of the key because one operator can migrate several source tenants, and
 * `https://contoso.crm.dynamics.com` means a different environment in each.
 */
export interface EnvPairing {
  appUserId: string;
  tenantId: string;
  /** Dataverse environment url, exactly as the environments list reports it. */
  envUrl: string;
  /** Google Cloud project id the agents from this environment are created in. */
  project: string;
  /** Discovery Engine engine/app id under that project. */
  engine: string;
  /** Assistant under the engine. Always 'default_assistant' today. */
  assistant: string;
  updatedAt: Date;
}

const COLL = 'envPairings';

/** Every pairing this customer has made for this source tenant. */
export async function listEnvPairings(appUserId: string, tenantId: string): Promise<EnvPairing[]> {
  if (!isDbConnected()) return [];
  try {
    return await getDb(config.CSGE_DB)
      .collection<EnvPairing>(COLL)
      .find({ appUserId, tenantId })
      .toArray();
  } catch (e) {
    logger.warn(`listEnvPairings read failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Replace the pairings for the environments named in `pairs`, leaving every other
 * environment's pairing alone.
 *
 * A PARTIAL save, deliberately — the same shape the identity map uses. The Connect screen
 * posts what it currently has on screen, and an environment the customer has not touched
 * in this visit must not be unpaired because it was absent from one request.
 */
export async function saveEnvPairings(
  appUserId: string,
  tenantId: string,
  pairs: Array<{ envUrl: string; project: string; engine: string; assistant?: string }>,
): Promise<void> {
  if (!isDbConnected() || pairs.length === 0) return;
  try {
    const coll = getDb(config.CSGE_DB).collection<EnvPairing>(COLL);
    const now = new Date();
    await coll.bulkWrite(
      pairs.map((p) => ({
        updateOne: {
          filter: { appUserId, tenantId, envUrl: p.envUrl },
          update: {
            $set: {
              project: p.project,
              engine: p.engine,
              assistant: p.assistant ?? 'default_assistant',
              updatedAt: now,
            },
          },
          upsert: true,
        },
      })),
    );
  } catch (e) {
    // Best-effort, like every other repo here: a pairing that cannot be persisted still
    // works for this session (the client holds it too) rather than failing the save.
    logger.warn(`saveEnvPairings write failed: ${(e as Error).message}`);
  }
}

/** Forget one environment's pairing — used when a customer clears their choice. */
export async function deleteEnvPairing(appUserId: string, tenantId: string, envUrl: string): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection<EnvPairing>(COLL).deleteOne({ appUserId, tenantId, envUrl });
  } catch (e) {
    logger.warn(`deleteEnvPairing failed: ${(e as Error).message}`);
  }
}

/**
 * The ONE project a customer's credentials belong in, or null when that cannot be said.
 *
 * Credentials are per CUSTOMER, but a secret has to be written to some specific project,
 * and the pairing is per ENVIRONMENT — so two environments pointed at two projects give
 * no single answer. Returning null there is the point: the caller then keeps whatever it
 * was already using rather than picking one of two projects at random and writing the
 * customer's token into it. Guessing is the failure this whole module exists to end.
 */
export function soleProject(pairings: Array<{ project: string }>): string | null {
  const projects = [...new Set(pairings.map((p) => p.project).filter(Boolean))];
  return projects.length === 1 ? projects[0] : null;
}
