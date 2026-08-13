import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { connectDb, getDb } from './core.js';

/**
 * CS_GE persistence bootstrap. Mirrors the GEM_CO reference (src/db/mongo.js):
 * connect once on startup, then idempotently create every collection + index.
 *
 * All migration-scoped collections carry `appUserId` for multi-tenancy, exactly
 * like GEM_CO.
 */

const CSGE_DB = config.CSGE_DB;

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

  // 1b. appLoginSessions — server-side sign-in sessions (opaque cookie token → appUserId).
  //     Server-side rather than a JWT so signing out can actually revoke; the TTL index is
  //     the backstop for the ones nobody signs out of.
  await ensure('appLoginSessions');
  await db.collection('appLoginSessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('appLoginSessions').createIndex({ appUserId: 1 });

  // 2. authSessions — OAuth tokens per user+provider+account (multi-account).
  await ensure('authSessions');
  await db.collection('authSessions').createIndex(
    { appUserId: 1, provider: 1, accountId: 1 },
    { unique: true, partialFilterExpression: { accountId: { $type: 'string' } } },
  );

  // 3. migrationSessions — DB-backed replacement for the in-memory sessionStore.
  //    _id is the session id. A cloud connection is meant to persist until the
  //    user explicitly disconnects it, so there is no expiry — drop any TTL
  //    index left over from an earlier version of this collection.
  await ensure('migrationSessions');
  await db.collection('migrationSessions').createIndex({ appUserId: 1 });
  try { await db.collection('migrationSessions').dropIndex('createdAt_1'); } catch {}

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
  // appUserId leads the read index: every read is tenant-scoped (see listStaged), so the
  // index must be too, or the scoping is enforced in code and paid for in a collection scan.
  await db.collection('stagedAgents').createIndex({ appUserId: 1, runId: 1, status: 1 });

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

  // 11b. connectorCredentials — per (customer, third-party connector) record of
  //      WHICH credential fields were supplied and the Secret Manager secret id
  //      each one lives under. Replaces `plan.savedConnectors` on the session,
  //      which died with the session TTL and made a customer re-enter Jira /
  //      Confluence credentials that were already in Secret Manager. Stores
  //      field names and secret ids only — never a credential value.
  await ensure('connectorCredentials');
  await db.collection('connectorCredentials').createIndex(
    { appUserId: 1, connectorId: 1 },
    { unique: true },
  );

  // 11b. connectorOpIndexes — a connector's operation schema as captured from the
  //      CUSTOMER'S own Power Platform environment. The committed fixtures are another
  //      tenant's view; a customer installs a different set of connectors, sometimes at
  //      different versions, so their environment is the authority and this is the cache.
  //      Not secret, but it does reveal which connectors a customer has installed, so it
  //      is scoped like everything else.
  await ensure('connectorOpIndexes');
  await db.collection('connectorOpIndexes').createIndex(
    { scope: 1, environmentId: 1, connectorId: 1 },
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

  // 13. adkKnowledgeStores — per (customer, agent, file) Discovery Engine
  //     "document" data store already created+imported for grounding a
  //     locally-uploaded file on an ADK/Reasoning-Engine agent, so a re-run
  //     reuses the existing data store instead of re-uploading to GCS and
  //     re-indexing every time. See knowledgeDataStoreExecutor.migrateFileToDocumentStore.
  await ensure('adkKnowledgeStores');
  // The key MUST include `project`. A data store lives in one project and is unreadable
  // from another, so the same file legitimately has one store per project — which is why
  // upsertAdkKnowledgeStore filters on project too. While the unique index omitted it,
  // that filter matched nothing for a second project and the upsert fell through to an
  // insert that the 3-field index then rejected: `E11000 duplicate key ... index:
  // appUserId_1_sourceId_1_fileName_1` (live 2026-08-07). The write is best-effort, so
  // the failure was only a warning — and the store record silently never updated.
  await db.collection('adkKnowledgeStores').createIndex(
    { appUserId: 1, project: 1, sourceId: 1, fileName: 1 },
    { unique: true, name: 'adkKnowledgeStores_tenant_project_source_file' },
  );
  // Drop the superseded index if this database predates the fix. Best-effort: a fresh
  // database never had it, and failing to drop it must not stop the app from booting.
  try {
    await db.collection('adkKnowledgeStores').dropIndex('appUserId_1_sourceId_1_fileName_1');
    logger.info('adkKnowledgeStores: dropped stale unique index missing `project`');
  } catch {
    /* not present — nothing to do */
  }

  // 14. identityMappings — durable Entra/email → Google Workspace override map
  //     per (customer, Microsoft tenant). Used for permission handoff / owner
  //     remap; never stores secrets.
  await ensure('identityMappings');
  await db.collection('identityMappings').createIndex(
    { appUserId: 1, tenantId: 1 },
    { unique: true },
  );

  // 15. pendingGroundingRechecks — a file-grounding attempt that timed out
  //     before Discovery Engine confirmed indexing (observed live to take
  //     6-10+ minutes past import). services/groundingRecheck.ts sweeps this
  //     on an interval and auto-repairs the deployed agent once indexing
  //     actually completes — see db/repos/pendingGroundingRechecks.ts.
  await ensure('pendingGroundingRechecks');
  await db.collection('pendingGroundingRechecks').createIndex(
    { appUserId: 1, envUrl: 1, sourceId: 1, fileName: 1 },
    { unique: true },
  );
  await db.collection('pendingGroundingRechecks').createIndex({ nextCheckAt: 1 });

  // 16. resolvedPrincipalCache — per (customer, Microsoft tenant, engine, Google
  //     identity) cache of whether a principal already holds a Gemini Enterprise
  //     license and the engine-scoped agentspaceUser role. Protects the two
  //     rate-limited Discovery Engine checks ensureAgentAccess makes before its
  //     existing per-agent grant — see services/gemini.ts and
  //     .claude/memory/decisions.md, 2026-08-12. Distinct from `identityMappings`
  //     (that's the customer's manual override map; this is checked API state).
  await ensure('resolvedPrincipalCache');
  await db.collection('resolvedPrincipalCache').createIndex(
    { appUserId: 1, tenantId: 1, engine: 1, googleEmail: 1 },
    { unique: true },
  );

  // 17. agentConnectorIdentity — which Google account ONE SPECIFIC source agent's
  //     connector should impersonate (Erik's agent -> Erik's Drive, Alex's -> Alex's),
  //     distinct from the shared service-account key used across a whole migration.
  //     See db/repos/agentConnectorIdentity.ts and
  //     docs/connector-architecture-decisions.md §12.5.
  await ensure('agentConnectorIdentity');
  await db.collection('agentConnectorIdentity').createIndex(
    { appUserId: 1, sourceId: 1, connectorId: 1 },
    { unique: true },
  );

  // ── Seed the first accounts ───────────────────────────────────────────────
  //
  // The credentials come from the environment, never from this file. They used to be
  // literals here, which meant every deployment that had not changed them could be signed
  // into by anyone who read the repo — and this tool holds two clouds' admin tokens for
  // several customers, so that is a compromise of the customers, not of us.
  //
  // Seeding still happens on a fresh database so a deployment comes up usable; it just
  // needs the values supplied. With none supplied in production, nothing is seeded and the
  // startup log says why.
  const userCount = await db.collection('appUsers').countDocuments();
  if (userCount === 0) {
    const isProd = process.env.NODE_ENV === 'production';
    const seeds = [
      {
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
        name: process.env.SEED_ADMIN_NAME ?? 'Admin User',
        role: 'admin' as const,
        // Local convenience only. Never applied in production.
        devFallback: { email: 'admin@cloudfuze.com', password: 'CloudFuze@2026' },
      },
      {
        email: process.env.SEED_DEMO_EMAIL,
        password: process.env.SEED_DEMO_PASSWORD,
        name: process.env.SEED_DEMO_NAME ?? 'Demo User',
        role: 'user' as const,
        devFallback: { email: 'demo@cloudfuze.com', password: 'Demo@2026' },
      },
    ];

    const docs = [];
    for (const s of seeds) {
      const email = s.email ?? (isProd ? undefined : s.devFallback.email);
      const password = s.password ?? (isProd ? undefined : s.devFallback.password);
      if (!email || !password) continue;
      docs.push({
        email: email.trim().toLowerCase(),
        password: await bcrypt.hash(password, 10),
        name: s.name,
        role: s.role,
        createdAt: new Date(),
        // True when the password came from a checked-in dev default rather than the
        // operator. Surfaced at startup so it cannot quietly become the production login.
        seededWithDevDefault: !s.password,
      });
    }

    if (docs.length) {
      await db.collection('appUsers').insertMany(docs);
      logger.info(`Seeded ${docs.length} app user(s): ${docs.map((d) => d.email).join(', ')}`);
      if (docs.some((d) => d.seededWithDevDefault)) {
        logger.warn(
          'One or more seeded accounts use the built-in DEVELOPMENT password. Set ' +
            'SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD (and SEED_DEMO_*) before exposing this instance.',
        );
      }
    } else {
      logger.warn(
        'No app users exist and none were seeded — set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, ' +
          'then restart, or nobody can sign in.',
      );
    }
  }

  // ── Multi-tenant readiness: say out loud what is still unattributed ───────
  //
  // Rows left on the placeholder owner are reachable by any signed-in user (see
  // auth/sessionOwnership.ts). That is a deliberate transition, and a transition nobody
  // can see is indistinguishable from a bug, so it is counted on every boot.
  try {
    const legacy = await db.collection('migrationSessions').countDocuments({
      $or: [{ appUserId: 'default' }, { appUserId: { $exists: false } }],
    });
    if (legacy > 0) {
      logger.warn(
        `${legacy} migration session(s) still owned by the placeholder 'default' user — any ` +
          'signed-in user can reach them. Run `npx tsx src/scripts/rekeyAppUser.ts` to assign a real owner.',
      );
    }
  } catch {
    /* best-effort: a count failing must never stop the app booting */
  }

  logger.info('All 17 collections verified with indexes (multi-tenant scoped)');
}
