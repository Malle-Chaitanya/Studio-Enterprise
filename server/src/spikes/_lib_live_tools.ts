/**
 * Shared harness for proving a connector's tools against the real vendor.
 *
 * WHY THIS EXISTS, and why it is not another hand-rolled spike:
 *
 * The Confluence and Jira harnesses each re-implemented `secret`, `fill` and `auth_header`
 * inline before calling `build_tools`. That proves the SPIKE's idea of the contract, not the
 * shipped one — and the contract is exactly where the expensive bugs live (a module-level
 * helper that pickles by reference, an empty auth header for the bearer kind, a base URL
 * template filled one way locally and another in the container). A harness that reimplements
 * the caller cannot catch a bug in the caller.
 *
 * So this one calls the REAL entry point: `adk_deploy._build_live_connector_tool(conn,
 * project)`, the same function the deployer calls, fed a `conn` built by the same
 * `buildLiveConnectorSpecsDetailed` the orchestrator uses. If the tools load here, they load
 * in the container for the same reasons; if the auth header is empty here, it is empty there.
 *
 * The one thing it cannot prove is cloudpickle behaviour — a module-level helper still
 * resolves fine in-process. `connectors/toolModule.test.ts` guards that separately.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../db/core.js';
import { buildLiveConnectorSpecsDetailed } from '../services/connectorToolBuilder.js';
import { connectorSecretId } from '../services/connectorCredentials.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

const SCRIPTS = resolve('./scripts');

export type CredRecord = {
  connectorId?: string;
  project?: string;
  secretIds?: Record<string, string>;
  ownerScope?: string;
};

/**
 * Build the `conn` spec for one connector exactly as the orchestrator would, from the
 * customer's own stored credential records.
 *
 * `operations` is filled from what STAGED AGENTS really call, because the deployer feeds that
 * list into the tool descriptions ("prefer these operations"). A harness that omits it tests
 * a differently-described tool than the one the customer gets.
 */
export async function buildConnSpec(connectorId: string): Promise<{
  conn: Record<string, unknown>;
  project: string;
  operations: Array<{ id: string; agents: number }>;
}> {
  const db = getDb();
  const recs = (await db.collection('connectorCredentials').find({}).toArray()) as CredRecord[];
  const storedSecretIds = Object.fromEntries(
    recs.filter((r) => r.connectorId).map((r) => [r.connectorId!, r.secretIds ?? {}]),
  );
  const own = recs.find((r) => r.connectorId === connectorId);
  const project = own?.project ?? process.env.GEMINI_PROJECT_FALLBACK ?? 'studio-enterprise-migration';
  const ownerScope = own?.ownerScope ?? 'default';

  const { specs, unsupported } = buildLiveConnectorSpecsDetailed([connectorId], {
    ownerScope,
    storedSecretIds,
  });
  if (!specs.length) {
    throw new Error(`no live spec for ${connectorId}${unsupported.length ? ' (unsupported)' : ''}`);
  }

  // What real agents ask of this connector — measured, never assumed.
  const staged = await db.collection('stagedAgents').find({}).toArray();
  const counts = new Map<string, number>();
  for (const row of staged as Array<Record<string, unknown>>) {
    const mapped = row.mapped as { ir?: { agentTools?: Array<Record<string, unknown>> } } | undefined;
    for (const t of mapped?.ir?.agentTools ?? []) {
      if (String(t.connectorId ?? '') !== connectorId) continue;
      const op = String(t.operationId ?? '');
      if (op) counts.set(op, (counts.get(op) ?? 0) + 1);
    }
  }
  const operations = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([id, agents]) => ({ id, agents }));

  const conn = { ...specs[0], operations: operations.map((o) => ({ id: o.id })) } as Record<string, unknown>;

  // PER-AGENT IDENTITY, or the harness proves a configuration that never ships.
  //
  // Google connectors act as a PERSON via domain-wide delegation, and which person is a
  // per-agent fact (orchestrator.ts ~2215): the orchestrator writes an agent-scoped
  // `impersonate_email` secret and injects its id, and DROPS the connector entirely when no
  // identity is confirmed. Running as the bare service account instead is not a milder
  // version of the same test — a service account owns no Drive, so root listed 0 items and
  // the media upload 403'd, both of which look like tool bugs and are neither.
  // SHAREPOINT/ONEDRIVE SCOPE, for the same reason the Drive identity block exists below.
  //
  // The tools refuse to run unscoped, and correctly: the app credential carries
  // Sites.Read.All, which reads EVERY site in the tenant, while the source agent named one
  // folder. So `scopeUri` is a per-AGENT fact taken from the agent's own SharePoint knowledge
  // source (orchestrator.ts ~1471), and without it every tool returns "no SharePoint scope
  // configured for this agent" — which is the tool being careful, not the tool being broken.
  if (/sharepoint|onedrive/i.test(String(conn.kind ?? ''))) {
    const uris = new Set<string>();
    for (const row of staged as Array<Record<string, unknown>>) {
      const mapped = row.mapped as
        | { ir?: { knowledgeSources?: Array<{ kind?: string; reference?: string; references?: string[] }> } }
        | undefined;
      for (const ksrc of mapped?.ir?.knowledgeSources ?? []) {
        if (ksrc.kind === 'FileUpload') continue;
        const addr = (ksrc.reference ?? ksrc.references?.[0] ?? '').trim();
        if (/^https?:\/\//i.test(addr) && /sharepoint\.com/i.test(addr)) uris.add(addr);
      }
    }
    // FOLDERS, not files — matching the orchestrator's own filter (~1470): a source that
    // names one FILE is fetched and indexed by copy mode and is deliberately NOT used as a
    // tool scope, because handing a file path to the folder tools gives them a scope with no
    // children. Taking uris[0] blindly picked `.../daily_queries.txt`, and
    // sharepoint_list_files answered HTTP 422 — a harness artefact that reads exactly like a
    // product bug.
    const looksLikeFile = (u: string) => /\.[a-z0-9]{2,5}(?:\?|#|$)/i.test(u.split('/').pop() ?? '');
    const all = [...uris];
    const list = [...all.filter((u) => !looksLikeFile(u)), ...all.filter(looksLikeFile)];
    if (list.length) {
      conn.scopeUri = list[0];
      if (list.length > 1) conn.scopeUris = list;
      const kind = looksLikeFile(list[0]) ? ' (a FILE — no folder source exists to scope to)' : '';
      console.log(`scope      : ${list[0]}${kind}${list.length > 1 ? ` (+${list.length - 1} more)` : ''}`);
    } else {
      console.log('scope      : NO SharePoint knowledge source on any staged agent — the tools will refuse to run');
    }
  }

  // Candidates in order of specificity, starting from an identity record when one exists.
  const identity = (await db.collection('agentConnectorIdentity').findOne({
    connectorId,
    status: 'confirmed',
  })) as { agentId?: string; sourceId?: string; impersonateEmail?: string } | null;
  const saToken = await getSaToken();
  const candidates: string[] = [];
  if (identity) {
    const agentId = identity.agentId ?? identity.sourceId ?? '';
    candidates.push(connectorSecretId(`${connectorId}:agent-${agentId}`, 'impersonate_email', ownerScope));
  }
  candidates.push(connectorSecretId(connectorId, 'impersonate_email', ownerScope));
  if (own?.secretIds?.impersonate_email) candidates.push(own.secretIds.impersonate_email);

  // ...then ASK Secret Manager, rather than guessing more names.
  //
  // Only Drive has an agentConnectorIdentity record, yet Teams was proven end to end earlier
  // in the project — its user lives under a differently-scoped name (an agent-scoped id under
  // one ownerScope, plus a legacy un-scoped one). Enumerating is the difference between
  // proving the tools and proving that they correctly refuse to guess a user: without this,
  // every Teams assertion failed with "No user is configured for this agent", which is the
  // tool behaving properly and the harness being wrong.
  const kindDashed = connectorId.replace(/^shared_/, 'shared-');
  try {
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${project}/secrets` +
        `?pageSize=300&filter=name:impersonate`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    const body = (await res.json()) as { secrets?: Array<{ name: string }> };
    const matching = (body.secrets ?? [])
      .map((x) => x.name.split('/').pop()!)
      .filter((n) => n.includes(`-${kindDashed}-`) && n.endsWith('-impersonate-email'))
      // An agent-scoped secret is what a real deploy uses, so prefer it; among equals prefer
      // the longer (more specific) name over the legacy un-scoped one.
      .sort((a, b) => Number(b.includes('-agent-')) - Number(a.includes('-agent-')) || b.length - a.length);
    candidates.push(...matching);
  } catch {
    /* enumeration is a convenience; the explicit candidates above still apply */
  }

  let chosen: string | undefined;
  let actingAs: string | undefined;
  for (const cand of [...new Set(candidates)]) {
    const got = await getEntraSecret(saToken, `projects/${project}/secrets/${cand}/versions/latest`);
    if (got.ok && got.plaintext?.trim()) {
      chosen = cand;
      actingAs = got.plaintext.trim();
      break;
    }
  }
  if (chosen) {
    conn.secretIds = { ...((conn.secretIds as Record<string, string>) ?? {}), impersonate_email: chosen };
    console.log(`identity   : acting as ${actingAs} (secret ${chosen})`);
  } else if (identity?.impersonateEmail) {
    console.log(
      `identity   : ${identity.impersonateEmail} is confirmed but NO readable impersonate_email ` +
        `secret exists — the tools will run with no user, which is not a shipping configuration.`,
    );
  }
  return { conn, project, operations };
}

/**
 * Load the connector's tools through the shipped deployer function and run `assertions`
 * against them.
 *
 * `assertions` is Python source that receives:
 *   T     — dict of tool name -> callable
 *   check(name, result, want=None, note="") — records a pass/fail, treating any
 *           {"error": ...} as a failure
 *   ok(name, note="") / fail(name, why) — for assertions about a tool's WORDING rather
 *           than its data (e.g. that a narrowed tool declares what it lost)
 *
 * The tool list is printed before assertions run, so a missing tool is visible even when
 * every assertion that referenced it errors out.
 */
export function runToolAssertions(
  conn: Record<string, unknown>,
  project: string,
  assertions: string,
): { code: number; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), 'livetools-'));
  const connPath = join(dir, 'conn.json');
  writeFileSync(connPath, JSON.stringify(conn), 'utf8');
  const assertPath = join(dir, 'assertions.py');
  writeFileSync(assertPath, assertions, 'utf8');

  // The driver is written to a file rather than passed with `python -c`: the assertion
  // bodies contain quotes, braces and newlines, and every attempt to inline them turned
  // into an escaping bug that looked like a connector bug.
  const driver = `
import json, sys, io, traceback
sys.path.insert(0, r"${SCRIPTS.replace(/\\/g, '\\\\')}")
# Deployment imports vertexai and creates a Reasoning Engine. We want only the tool
# factory, so import the module and call the one function.
import adk_deploy

conn = json.load(open(r"${connPath.replace(/\\/g, '\\\\')}", encoding="utf-8"))
built = adk_deploy._build_live_connector_tool(conn, ${JSON.stringify(project)})
# Same normalisation the deployer applies: a module may return one bare function or a list.
tools = list(built) if isinstance(built, (list, tuple)) else [built]
T = {}
for t in tools:
    n = getattr(t, "__name__", None) or getattr(t, "name", None)
    if n:
        T[str(n)] = t
print(f"{len(T)} tool(s) loaded: {', '.join(sorted(T))}\\n")

passed = 0
failed = []

def fail(name, why):
    failed.append((name, str(why)))
    print(f"FAIL  {str(name):34s} {str(why)[:76]}")

def ok(name, note=""):
    global passed
    passed += 1
    print(f"PASS  {str(name):34s} {note}")

def check(name, result, want=None, note=""):
    # An {"error": ...} return is the module's own honest failure signal, so it is a FAIL
    # here — except in the negative cases, which call ok()/fail() directly.
    if isinstance(result, dict) and result.get("error"):
        fail(name, result["error"]); return False
    if want is not None:
        try:
            good = want(result)
        except Exception as e:  # noqa: BLE001
            fail(name, f"predicate raised: {e}"); return False
        if not good:
            fail(name, "unexpected: " + json.dumps(result, default=str)[:70]); return False
    ok(name, note); return True

try:
    exec(open(r"${assertPath.replace(/\\/g, '\\\\')}", encoding="utf-8").read())
except Exception:
    traceback.print_exc()
    failed.append(("harness", "assertions raised"))

print(f"\\n{passed} passed, {len(failed)} failed")
for n, e in failed:
    print(f"  FAILED {n}: {e[:200]}")
sys.exit(1 if failed else 0)
`;
  const driverPath = join(dir, 'driver.py');
  writeFileSync(driverPath, driver, 'utf8');

  const res = spawnSync('python', [driverPath], { encoding: 'utf8', timeout: 600_000 });
  return { code: res.status ?? -1, out: res.stdout ?? '', err: res.stderr ?? '' };
}

/** Print a harness result and exit with its code. */
export function report(r: { code: number; out: string; err: string }): never {
  if (r.out) console.log(r.out.trimEnd());
  if (r.err?.trim()) console.log('--- stderr ---\n' + r.err.trim().slice(0, 3000));
  process.exit(r.code === 0 ? 0 : 1);
}
