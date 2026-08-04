/**
 * Read-only: recursively list every file in Erik's OneDrive (real Graph
 * /children listing, NOT the relevance-based /search used by graphSearch.ts)
 * and report which filenames occur exactly once. Purpose: find a genuinely
 * unique test file for a live end-to-end SharePoint/OneDrive migration test,
 * since /search proved unreliable (false-positive on "TestingPermissions",
 * and duplicate-name collisions on the existing test files).
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const OWNER = 'erik@filefuze.co';

interface Item {
  name: string;
  path: string;
  sizeBytes: number;
  isFolder: boolean;
  driveId: string;
  itemId: string;
}

async function listChildren(token: string, driveId: string, itemId: string, path: string): Promise<Item[]> {
  const out: Item[] = [];
  let url = `${GRAPH}/drives/${driveId}/items/${itemId}/children?$select=id,name,size,file,folder,parentReference&$top=200`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error(`  listChildren failed at ${path}: ${res.status}`);
      break;
    }
    const json = (await res.json()) as { value?: any[]; '@odata.nextLink'?: string };
    for (const it of json.value ?? []) {
      const isFolder = Boolean(it.folder);
      out.push({
        name: it.name,
        path: `${path}/${it.name}`,
        sizeBytes: it.size ?? 0,
        isFolder,
        driveId,
        itemId: it.id,
      });
    }
    url = json['@odata.nextLink'] ?? '';
  }
  return out;
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.tenantId) throw new Error('no usable session found');

  const graphToken = await clientCredsToken(s.tenantId, 'https://graph.microsoft.com');

  const rootRes = await fetch(`${GRAPH}/users/${encodeURIComponent(OWNER)}/drive/root?$select=id,parentReference`, {
    headers: { Authorization: `Bearer ${graphToken}` },
  });
  if (!rootRes.ok) throw new Error(`root lookup failed: ${rootRes.status} ${await rootRes.text()}`);
  const root = (await rootRes.json()) as { id: string; parentReference?: { driveId?: string } };
  const driveId = root.parentReference?.driveId;
  if (!driveId) {
    // root item's own driveId isn't in parentReference; fetch drive directly
    const driveRes = await fetch(`${GRAPH}/users/${encodeURIComponent(OWNER)}/drive?$select=id`, {
      headers: { Authorization: `Bearer ${graphToken}` },
    });
    const drive = (await driveRes.json()) as { id: string };
    console.log(`Using drive id from /drive: ${drive.id}`);
    await walk(graphToken, drive.id, root.id, '');
    process.exit(0);
  }
  await walk(graphToken, driveId, root.id, '');
  process.exit(0);
}

async function walk(token: string, driveId: string, rootItemId: string, _unused: string) {
  const all: Item[] = [];
  const queue: { itemId: string; path: string }[] = [{ itemId: rootItemId, path: '' }];
  let folders = 0;
  while (queue.length) {
    const { itemId, path } = queue.shift()!;
    const children = await listChildren(token, driveId, itemId, path);
    for (const c of children) {
      if (c.isFolder) {
        folders++;
        queue.push({ itemId: c.itemId, path: c.path });
      } else {
        all.push(c);
      }
    }
  }

  console.log(`Walked ${folders} folder(s), found ${all.length} file(s) total in ${OWNER}'s OneDrive.\n`);

  const byName = new Map<string, Item[]>();
  for (const f of all) {
    const arr = byName.get(f.name) ?? [];
    arr.push(f);
    byName.set(f.name, arr);
  }

  const unique = [...byName.entries()].filter(([, items]) => items.length === 1);
  const dupes = [...byName.entries()].filter(([, items]) => items.length > 1);

  console.log(`=== UNIQUE filenames (exactly 1 file with this name) — ${unique.length} ===`);
  for (const [name, items] of unique) {
    console.log(`  "${name}" — ${items[0].sizeBytes}b at ${items[0].path}  (driveId=${items[0].driveId} itemId=${items[0].itemId})`);
  }

  console.log(`\n=== DUPLICATE filenames (2+ files with this name) — ${dupes.length} ===`);
  for (const [name, items] of dupes) {
    console.log(`  "${name}" — ${items.length} copies:`);
    for (const it of items) console.log(`      ${it.path} (${it.sizeBytes}b)`);
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
