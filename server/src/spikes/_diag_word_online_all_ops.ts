const { getDb, connectDb, closeDb } = await import('../db/core.js');
const { config } = await import('../config.js');
async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb();
  const ops = await db.collection('connectorOperations').find({ connectorId: 'shared_wordonlinebusiness' } as never).toArray();
  console.log(`${ops.length} operations for shared_wordonlinebusiness:\n`);
  for (const op of ops) {
    const o = op as any;
    console.log(o.operationId, '|', o.method, o.path, '|', o.summary);
  }
}
main().then(() => closeDb()).catch(e => console.error(e)).finally(() => process.exit(0));
