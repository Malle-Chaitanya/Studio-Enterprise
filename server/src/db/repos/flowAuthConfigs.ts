import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * Tracks which credential VALUES an Application Integration AuthConfig was last built
 * from, so a customer rotating their Azure client secret (or replacing the app
 * registration) gets detected and the AuthConfig updated in place — instead of
 * `ensureAuthConfig` seeing "an AuthConfig with this name already exists" and silently
 * leaving it pointed at a now-invalid secret forever.
 *
 * WHY A SEPARATE HASH, NOT A DIRECT COMPARE: Application Integration's AuthConfig
 * stores credentials write-only (`encryptedCredential` on read, never the plaintext),
 * so there is no way to ask Google "does this still match" — the comparison has to
 * happen on OUR side, against what we last wrote. Same idiom this codebase already
 * uses for regular secrets (secretManager.ts's upsertSecretIfChanged) and for flow
 * integration definitions (db/repos/flowIntegrations.ts's definitionHash) — applied
 * here one layer down, for the credential itself.
 *
 * Collection: flowAuthConfigs (unique per {appUserId, project, authConfigName}).
 */

const COLL = 'flowAuthConfigs';

export async function getFlowAuthConfigHash(
  appUserId: string,
  project: string,
  authConfigName: string,
): Promise<string | null> {
  if (!isDbConnected()) return null;
  try {
    const doc = await getDb(config.CSGE_DB)
      .collection(COLL)
      .findOne<{ credentialHash: string }>({ appUserId, project, authConfigName });
    return doc?.credentialHash ?? null;
  } catch (e) {
    logger.warn(`getFlowAuthConfigHash read failed: ${(e as Error).message}`);
    return null;
  }
}

export async function recordFlowAuthConfigHash(
  appUserId: string,
  project: string,
  authConfigName: string,
  credentialHash: string,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, project, authConfigName },
      { $set: { appUserId, project, authConfigName, credentialHash, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`recordFlowAuthConfigHash persist failed: ${(e as Error).message}`);
  }
}
