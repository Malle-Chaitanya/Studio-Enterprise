/**
 * Read the REAL captured Microsoft swagger data (host, path, params) for the operations
 * behind shared_planner and shared_powerplatformforadmins, straight from the DB capture —
 * rather than guess at what registry.ts should say.
 *
 * Run: npx tsx src/spikes/_diag_check_captured_ops.ts
 */
const { getDb, connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = await getDb();
  if (!db) throw new Error('no db');

  for (const connectorId of ['shared_planner', 'shared_powerplatformforadmins', 'shared_powerapps']) {
    const conn = await db.collection('connectors').findOne({ _id: connectorId } as never);
    console.log(`\n=== ${connectorId} ===`);
    console.log('connector doc keys:', conn ? Object.keys(conn) : 'NOT FOUND');
    if (conn) console.log(JSON.stringify(conn, null, 2).slice(0, 1500));

    const ops = await db
      .collection('connectorOperations')
      .find({ connectorId } as never)
      .toArray();
    console.log(`  ${ops.length} operations captured`);
    for (const op of ops) {
      const o = op as any;
      if (/app|admin|plan/i.test(o.operationId ?? o.summary ?? '')) {
        console.log('  ---', o.operationId, '|', o.summary);
        console.log('     method:', o.method, 'path:', o.path);
        console.log('     host/basePath:', o.host, o.basePath);
      }
    }
  }
}

main()
  .then(() => closeDb())
  .catch((e) => {
    console.error('FAILED:', e);
  })
  .finally(() => process.exit(0));
