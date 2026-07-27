import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from './dataverse.js';
import type { Session } from '../sessionStore.js';
import type { DestinationOptions, MigrationScope, ResolvedPlan, ScopeUnit } from '../types.js';

/**
 * Scope resolution — the ONE new concept the flexible architecture needs.
 *
 * Expands any MigrationScope (single agent → all environments) into a flat
 * work-list of environments + their agents. Everything downstream (extract,
 * assess, map, create) is scope-agnostic and runs over this list unchanged.
 */

function envByRef(session: Session, ref: string) {
  return session.environments?.find((e) => e.url === ref || e.id === ref);
}

async function botsFor(session: Session, envUrl: string): Promise<ScopeUnit | null> {
  try {
    const token = await clientCredsToken(session.tenantId ?? '', envUrl);
    const bots = await listBots(envUrl, token);
    const env = session.environments?.find((e) => e.url === envUrl);
    return { envUrl, envName: env?.name ?? envUrl, bots };
  } catch {
    // Inaccessible environment (e.g. 403) — skip it rather than fail the plan.
    return null;
  }
}

export async function resolveScope(
  session: Session,
  scope: MigrationScope,
  destination: DestinationOptions,
): Promise<ResolvedPlan> {
  const units: ScopeUnit[] = [];

  if (scope.kind === 'agents') {
    const env = envByRef(session, scope.env);
    if (env) {
      const unit = await botsFor(session, env.url);
      if (unit) {
        // Keep only the requested agents.
        const wanted = new Set(scope.botIds);
        unit.bots = unit.bots.filter((b) => wanted.has(b.botid));
        units.push(unit);
      }
    }
  } else if (scope.kind === 'selection') {
    // Exact per-environment agent picks (one agent, many, across envs).
    for (const u of scope.units) {
      const env = envByRef(session, u.env);
      if (!env) continue;
      const unit = await botsFor(session, env.url);
      if (!unit) continue;
      const wanted = new Set(u.botIds);
      unit.bots = unit.bots.filter((b) => wanted.has(b.botid));
      if (unit.bots.length) units.push(unit);
    }
  } else if (scope.kind === 'environments') {
    for (const ref of scope.envs) {
      const env = envByRef(session, ref);
      if (!env) continue;
      const unit = await botsFor(session, env.url);
      if (unit && unit.bots.length) units.push(unit);
    }
  } else {
    // tenant: every environment we can read
    for (const env of session.environments ?? []) {
      const unit = await botsFor(session, env.url);
      if (unit && unit.bots.length) units.push(unit);
    }
  }

  const totalAgents = units.reduce((n, u) => n + u.bots.length, 0);
  return { units, totalAgents, destination };
}
