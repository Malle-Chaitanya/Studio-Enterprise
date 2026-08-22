/**
 * Which connectors can a customer actually configure IN THE UI and end up with a working
 * agent? Three separate facts, kept separate on purpose:
 *
 *   ASKABLE   the Connectors screen can collect its credential (it declares fields or a group)
 *   LIVE      it gets real tools at runtime (a dedicated connector_tools module, not the
 *             generic REST fallback which only replays captured swagger)
 *   PROVEN    a deployed agent has actually called it and got real data back
 *
 * "Mapped" is not "built" is not "proven" — collapsing them is how a demo becomes a promise
 * the product cannot keep.
 */
import 'dotenv/config';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { hasDedicatedToolModule } from '../connectors/toolModule.js';

const rows = [...REGISTRY_BY_ID.values()].map((d) => {
  const kind = d.id.replace(/^shared_/, '');
  const askable = (d.credentials?.length ?? 0) > 0 || !!d.credentialGroup;
  return {
    id: d.id,
    name: d.name,
    askable,
    live: hasDedicatedToolModule(kind),
    group: d.credentialGroup ?? '-',
    auth: d.authKind ?? 'bearer',
  };
});

console.log('CONNECTOR                          askable  liveTools  credGroup    auth');
for (const r of rows.sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name))) {
  console.log(
    `${r.name.slice(0, 34).padEnd(35)} ${(r.askable ? 'yes' : 'NO ').padEnd(8)} ${(r.live ? 'YES' : 'generic').padEnd(10)} ${r.group.padEnd(12)} ${r.auth}`,
  );
}
console.log(`\n${rows.length} registered; ${rows.filter((r) => r.live).length} with purpose-built tools; ${rows.filter((r) => !r.askable).length} that cannot be asked for in the UI`);
process.exit(0);
