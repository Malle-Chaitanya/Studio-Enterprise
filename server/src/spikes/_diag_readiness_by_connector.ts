/**
 * Per connector: can an agent using it migrate and then WORK?
 *
 * Three different things get confused as "supported", so print them separately:
 *   creds     — a credential is saved (else tools deploy and fail on every call)
 *   identity  — a per-agent identity is confirmed, where the connector acts AS a person
 *   proven    — a tool of this connector answered with real data from a DEPLOYED agent
 * A connector missing any of the three can still deploy green, which is the trap.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { findCoverage } from '../connectors/coverage.js';
import { findEquivalence, surfaceForConnector } from '../connectors/equivalence.js';

const TIER1 = [
  'shared_teams', 'shared_googlechat', 'shared_office365', 'shared_outlook',
  'shared_googledrive', 'shared_confluence', 'shared_jira',
  'shared_sharepointonline', 'shared_onedrive',
  'shared_hubspot', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2', 'shared_hubspotcrm', 'shared_hubspotcms',
];

await connectMongo();
const db = getDb();
const creds = new Set(
  ((await db.collection('connectorCredentials').find({}).toArray()) as Array<Record<string, any>>).map((c) => String(c.connectorId)),
);
const identities = (await db.collection('agentConnectorIdentity').find({}).toArray()) as Array<Record<string, any>>;
const idByConnector = new Map<string, string[]>();
for (const i of identities) {
  if (i.status !== 'confirmed') continue;
  idByConnector.set(String(i.connectorId), [...(idByConnector.get(String(i.connectorId)) ?? []), String(i.impersonateEmail ?? '?')]);
}

// Which operations of this connector have a verdict claiming they are proven live?
function provenOps(id: string): { proven: number; total: number } {
  const surface = surfaceForConnector(id);
  let proven = 0;
  let total = 0;
  const staged = opsUsed.get(id) ?? new Set<string>();
  for (const op of staged) {
    total++;
    const cov = findCoverage(id, op);
    const eq = surface ? findEquivalence(surface, op) : undefined;
    if (cov?.verified || eq?.verified || eq?.graph?.verified) proven++;
  }
  return { proven, total };
}

// Operations real agents actually use, per connector (distinct agents irrelevant here).
const opsUsed = new Map<string, Set<string>>();
for (const row of (await db.collection('stagedAgents').find({}).toArray()) as Array<Record<string, any>>) {
  for (const t of row.mapped?.ir?.agentTools ?? []) {
    const c = String(t.connectorId ?? '');
    const op = String(t.operationId ?? '');
    if (!c || !op) continue;
    opsUsed.set(c, (opsUsed.get(c) ?? new Set()).add(op));
  }
}

console.log('connector'.padEnd(34) + 'creds  identity              ops proven');
for (const id of TIER1) {
  const def = REGISTRY_BY_ID.get(id);
  const { proven, total } = provenOps(id);
  const ident = idByConnector.get(id);
  console.log(
    `${(def?.name ?? id).slice(0, 32).padEnd(34)}${creds.has(id) ? ' yes ' : ' NO  '}  ${(ident ? ident.join(',') : '(none recorded)').slice(0, 20).padEnd(22)}${total ? `${proven}/${total}` : '-'}`,
  );
}
process.exit(0);
