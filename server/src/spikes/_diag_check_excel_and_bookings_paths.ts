const { getDb, connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');
async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb();
  for (const connectorId of ['shared_excelonlinebusiness', 'shared_microsoftbookings', 'shared_office365users']) {
    const ops = await db.collection('connectorOperations').find({ connectorId } as never).toArray();
    console.log(`\n=== ${connectorId} (${ops.length} ops) ===`);
    for (const op of ops.slice(0, 10)) {
      const o = op as any;
      console.log(o.operationId, '|', o.method, o.path);
    }
  }
}
main().then(() => closeDb()).catch(e => console.error(e)).finally(() => process.exit(0));
