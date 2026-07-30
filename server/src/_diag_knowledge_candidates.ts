/**
 * Read-only scan for test candidates for the two newly-wired knowledge paths:
 *   1. Dataverse reference-table snapshot (migrateDataverseSnapshot)
 *   2. SharePoint/OneDrive copy-mode files (rides the existing FileUpload path)
 *
 *   npx tsx src/_diag_knowledge_candidates.ts [sessionId]
 *
 * If sessionId is omitted, the most recently created session is used.
 * Touches Copilot Studio READ-ONLY — creates/changes nothing.
 */
import 'dotenv/config';
import { parse as parseYaml } from 'yaml';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { clientCredsToken } from './auth/microsoft.js';
import { classifyKnowledgeSource } from './services/knowledgeClassifier.js';

const SESSION_ID = process.argv[2];

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<{ value: Record<string, unknown>[] }>;
}

function refsFrom(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        if (typeof v === 'string' && v.trim() && /url|site|siteurl|reference|entity|path|connection/i.test(k)) out.push(v.trim());
        walk(v);
      }
    }
  };
  walk(doc);
  return [...new Set(out)];
}

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found — connect Microsoft via the web app first, or pass a sessionId');
  if (!s.environments?.length) throw new Error('session has no discovered environments');

  let dvSnapshotCandidates = 0;
  let fileAttachmentCandidates = 0;

  for (const env of s.environments) {
    let token: string;
    try {
      token = await clientCredsToken(s.tenantId ?? '', env.url);
    } catch (e) {
      console.log(`\n[${env.name}] token failed — ${(e as Error).message}`);
      continue;
    }

    let bots;
    try {
      bots = (await dvGet(env.url, token, `bots?$select=name,botid&$filter=statecode eq 0`)).value;
    } catch (e) {
      console.log(`\n[${env.name}] bot list failed — ${(e as Error).message}`);
      continue;
    }

    for (const bot of bots) {
      let comps;
      try {
        comps = (await dvGet(
          env.url,
          token,
          `botcomponents?$select=name,componenttype,data,filedata_name&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid}&$top=1000`,
        )).value;
      } catch {
        continue;
      }

      // Candidate 1: any Bot File Attachment (type 14) — proves the
      // FileUpload path, which is also what SharePoint/OneDrive copy-mode
      // files ride (Copilot copies those bytes into the same column).
      const fileComps = comps.filter((c) => Number(c.componenttype) === 14);
      if (fileComps.length) {
        fileAttachmentCandidates += fileComps.length;
        console.log(
          `\n[FILE-ATTACHMENT] agent "${bot.name}" (env ${env.name}): ${fileComps.length} file(s) — ` +
            fileComps.map((c) => c.filedata_name || c.name).join(', '),
        );
      }

      // Candidate 2: type-16 KnowledgeSource entries the classifier calls
      // dataverse-snapshot (a reference/catalog table, not sensitive).
      for (const c of comps.filter((x) => Number(x.componenttype) === 16)) {
        const data = String(c.data ?? '');
        let doc: Record<string, unknown> | null = null;
        try {
          doc = parseYaml(data) as Record<string, unknown>;
        } catch {
          /* keep raw */
        }
        const kind = (doc?.kind as string) ?? (doc?.knowledgeSourceType as string) ?? '';
        if (!kind) continue;
        const references = doc ? refsFrom(doc) : [];
        const cls = classifyKnowledgeSource({ kind: String(kind), references });
        if (cls.strategy === 'dataverse-snapshot') {
          dvSnapshotCandidates++;
          console.log(
            `\n[DATAVERSE-SNAPSHOT] agent "${bot.name}" (env ${env.name}): source "${c.name}" kind=${JSON.stringify(kind)} ` +
              `refs=${JSON.stringify(references)}`,
          );
        }
      }
    }
  }

  console.log(`\n--- summary ---`);
  console.log(`file-attachment candidates (proves copy-mode path): ${fileAttachmentCandidates}`);
  console.log(`dataverse-snapshot candidates: ${dvSnapshotCandidates}`);
  if (!fileAttachmentCandidates && !dvSnapshotCandidates) {
    console.log('No candidates found in this tenant — you may need to add a test knowledge source in Copilot Studio first.');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
