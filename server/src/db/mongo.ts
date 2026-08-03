import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { connectDb, getDb } from './core.js';

/**
 * CS_GE persistence bootstrap. Mirrors the GEM_CO reference (src/db/mongo.js):
 * connect once on startup, then idempotently create every collection + index.
 *
 * All migration-scoped collections carry `appUserId` for multi-tenancy, exactly
 * like GEM_CO. Session expiry uses a Mongo TTL index instead of a setInterval
 * sweep.
 */

const CSGE_DB = config.CSGE_DB;

/** Session lifetime — matches the old in-memory TTL (1 hour). */
const SESSION_TTL_SECONDS = 60 * 60;

/**
 * Connect to the csge database and ensure all collections + indexes exist.
 * Call once on startup before app.listen().
 */
export async function connectMongo(retries = 5, delayMs = 3000): Promise<void> {
  await connectDb(CSGE_DB, retries, delayMs);
  try {
    await ensureCollections();
  } catch (e) {
    logger.warn(`ensureCollections non-fatal error: ${(e as Error).message}`);
  }
}

async function ensureCollections(): Promise<void> {
  const db = getDb(CSGE_DB);
  const existing = new Set(
    (await db.listCollections().toArray()).map((c) => c.name),
  );
  const ensure = async (name: string) => {
    if (!existing.has(name)) await db.createCollection(name);
  };

  // 1. appUsers — login accounts (email unique, bcrypt password).
  await ensure('appUsers');
  await db.collection('appUsers').createIndex({ email: 1 }, { unique: true });

  // 2. authSessions — OAuth tokens per user+provider+account (multi-account).
  await ensure('authSessions');
  await db.collection('authSessions').createIndex(
    { appUserId: 1, provider: 1, accountId: 1 },
    { unique: true, partialFilterExpression: { accountId: { $type: 'string' } } },
  );

  // 3. migrationSessions — DB-backed replacement for the in-memory sessionStore.
  //    _id is the session id. TTL index expires docs SESSION_TTL_SECONDS after
  //    createdAt, replacing the old setInterval sweep.
  await ensure('migrationSessions');
  await db.collection('migrationSessions').createIndex({ appUserId: 1 });
  try { await db.collection('migrationSessions').dropIndex('createdAt_1'); } catch {}
  await db.collection('migrationSessions').createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: SESSION_TTL_SECONDS },
  );

  // 4. environmentsCache — discovered environments + inventory counts per tenant.
  await ensure('environmentsCache');
  await db.collection('environmentsCache').createIndex(
    { appUserId: 1, tenantId: 1 },
    { unique: true },
  );

  // 5. migrationRuns — one doc per migration run (scope + plan snapshot + summary).
  await ensure('migrationRuns');
  await db.collection('migrationRuns').createIndex({ appUserId: 1, startTime: -1 });

  // 6. migrationResults — one MigrationResult per agent per run.
  await ensure('migrationResults');
  await db.collection('migrationResults').createIndex(
    { runId: 1, sourceId: 1 },
    { unique: true },
  );
  await db.collection('migrationResults').createIndex({ appUserId: 1 });

  // 7. agentIRCache — extracted AgentIR + MappedAgent (audit / re-run without
  //    re-extracting from Dataverse).
  await ensure('agentIRCache');
  await db.collection('agentIRCache').createIndex(
    { appUserId: 1, envUrl: 1, sourceId: 1 },
    { unique: true },
  );

  // 8. migrationLogs — persisted SSE ProgressEvents per run.
  await ensure('migrationLogs');
  await db.collection('migrationLogs').createIndex({ appUserId: 1, runId: 1, ts: 1 });

  // 9. stagedAgents — the extract→load→insert staging area (fetch-then-migrate,
  //    same pattern as GEM_CO's conversationStore). Phase 1 writes rows here as
  //    `staged`; phase 2 reads them and flips each to `inserted`/`failed`.
  await ensure('stagedAgents');
  await db.collection('stagedAgents').createIndex({ runId: 1, sourceId: 1 }, { unique: true });
  await db.collection('stagedAgents').createIndex({ runId: 1, status: 1 });

  // 10. adkDeployments — tracks already-deployed ADK Reasoning Engines so a
  //     re-run reuses them instead of deploying a second, billable one (Vertex
  //     AI's Reasoning Engine create API has no name-based dedup of its own).
  await ensure('adkDeployments');
  await db.collection('adkDeployments').createIndex(
    { appUserId: 1, envUrl: 1, sourceId: 1, project: 1, engine: 1 },
    { unique: true },
  );

  // 11. knowledgeConnectors — per (customer, connector kind, site) SharePoint/
  //     OneDrive native-connector setup state. Replaces the old session-scoped
  //     `sharepointConnector` singleton, which could only track one site per
  //     whole migration session.
  await ensure('knowledgeConnectors');
  await db.collection('knowledgeConnectors').createIndex(
    { appUserId: 1, kind: 1, siteUrl: 1 },
    { unique: true },
  );

  // 12. entraAppCredentials — per (customer, Microsoft tenant) reference to a
  //     Secret Manager-stored Entra app credential, so a NEW site under an
  //     already-onboarded tenant can auto-provision a connector without asking
  //     the admin again. Never stores the plaintext secret (see
  //     services/secretManager.ts and .claude/memory/decisions.md, 2026-08-03).
  await ensure('entraAppCredentials');
  await db.collection('entraAppCredentials').createIndex(
    { appUserId: 1, tenantId: 1 },
    { unique: true },
  );

  // Seed default app users if empty (parity with GEM_CO).
  const userCount = await db.collection('appUsers').countDocuments();
  if (userCount === 0) {
    const defaultUsers = [
      { email: 'admin@cloudfuze.com', password: await bcrypt.hash('CloudFuze@2026', 10), name: 'Admin User', role: 'admin', createdAt: new Date() },
      { email: 'demo@cloudfuze.com', password: await bcrypt.hash('Demo@2026', 10), name: 'Demo User', role: 'user', createdAt: new Date() },
    ];
    await db.collection('appUsers').insertMany(defaultUsers);
    logger.info('Seeded 2 default app users');
  }

  logger.info('All 12 collections verified with indexes (multi-tenant scoped)');
}
