const { connectDb, closeDb, getDb } = await import('../db/core.js');
const { config } = await import('../config.js');

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const row = await db.collection('agentIRCache').findOne({ sourceId: 'c9176288-690a-4629-9d0a-cd8c86a29f2a' });
  if (!row) { console.log('NOT FOUND'); await closeDb(); return; }
  console.log('extractedAt:', row.extractedAt);
  const tools = row.ir.agentTools ?? [];
  console.log('total agentTools:', tools.length);
  const connectorIds = new Set(tools.filter((t: any) => t.kind === 'connector').map((t: any) => t.connectorId));
  console.log('distinct connector ids:', [...connectorIds]);
  const onedrive = tools.filter((t: any) => (t.connectorId ?? '').toLowerCase().includes('onedrive'));
  console.log('onedrive-related tools:', JSON.stringify(onedrive, null, 2));
  console.log('\nknowledgeSources count:', (row.ir.knowledgeSources ?? []).length);
  for (const ks of row.ir.knowledgeSources ?? []) {
    console.log(' ks kind:', ks.kind, '| classification.requiresConnectorId:', ks.classification?.requiresConnectorId);
  }
  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
