/**
 * Recover the real SharePoint address of a knowledge source that stored none.
 *
 * THE PROBLEM. Copilot Studio writes SharePoint knowledge in two shapes. One
 * (`SharePointSearchSource`) keeps the URL:
 *
 *     https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt
 *
 * The other (`FederatedStructuredSearchSource`) keeps only an opaque config-record id:
 *
 *     skillConfiguration: daily_queriestxt_ZEHQ13QHyGoE_iNOUiCtg
 *
 * The id resolves to nothing — measured, not assumed: searching Dataverse for it returns
 * only the component that already contains it. Copy mode (Graph download by URL) therefore
 * cannot run, and the source falls back to Gemini's native SharePoint connector, which is
 * confirmed to return zero content. So the shape of the source, not its content, decides
 * whether an agent gets its knowledge.
 *
 * THE RECOVERY. The same source is frequently attached to several agents in the tenant,
 * and the OTHER agents kept the URL (live 2026-08-13):
 *
 *     daily_queries.txt  [c2messagegeneratoragent]  -> https://…/TestingPermissions/daily_queries.txt
 *     daily_queries.txt  [KBGroundingTestAgent]     -> https://…/TestingPermissions/daily_queries.txt
 *     daily_queries.txt  [CSGEKnowledgeTestAgent]   -> (skillConfiguration only)
 *
 * So the address is present in the customer's own Dataverse; it is just on a different row.
 *
 * WHY THIS IS SAFE ENOUGH TO USE, AND WHERE IT STOPS. Grounding an agent on the WRONG
 * file is worse than not grounding it, so this refuses every case it cannot be sure of:
 * it requires an EXACT (case-insensitive) source-name match, and it requires every
 * matching row to agree on ONE url. Two rows with the same name and different addresses is
 * a real ambiguity, and it is returned as such rather than resolved by picking one.
 *
 * It is still an INFERENCE — a name match, not an identifier match — so every recovery is
 * reported as `needs-review` naming the component the address came from. This is the
 * difference between the tool recommending and the tool silently deciding.
 */
import { logger } from '../logger.js';

/** A recovered address, or the reason we refused to guess one. */
export type UrlRecovery =
  | { status: 'recovered'; url: string; fromSchemaName: string }
  | { status: 'ambiguous'; urls: string[] }
  | { status: 'not-found' };

interface ComponentRow {
  name?: string;
  schemaname?: string;
  data?: string;
  content?: string;
}

/** Only SharePoint/OneDrive addresses — a Confluence or website URL in the same payload
 *  must never be handed to the SharePoint downloader. */
const SP_URL = /https?:\/\/[^\s"'<>\\]*sharepoint\.com[^\s"'<>\\]*/i;

/** Trailing punctuation from YAML/JSON quoting must not become part of the address. */
function cleanUrl(raw: string): string {
  return raw.replace(/[.,;)\]}]+$/, '');
}

/**
 * Find the address of `sourceName` on any OTHER knowledge-source component in this
 * environment.
 *
 * Never throws: a failed recovery must degrade to the existing fallback, not fail the
 * migration. Read-only — one filtered Dataverse query.
 */
export async function recoverSharePointUrlByName(
  envUrl: string,
  dvToken: string,
  sourceName: string,
): Promise<UrlRecovery> {
  return recoverSharePointUrlAcrossEnvs([{ envUrl, dvToken }], sourceName);
}

/**
 * The same recovery, widened to every environment we can read in the tenant.
 *
 * SharePoint is TENANT-wide while Dataverse environments are not, so the agent that kept
 * the address is often in a different environment from the agent that lost it — measured:
 * "TestingPermissions" is address-less in CloudFuze Agent Migration Hub and fully addressed
 * in filefuze. Searching only the agent's own environment left that source with no copy and
 * no tool scope at all.
 *
 * The unanimity rule is applied across the WHOLE search, not per environment: if two
 * environments hold different addresses under one name, that is exactly the ambiguity this
 * must refuse, not a tie to break by preferring the nearer one.
 */
export async function recoverSharePointUrlAcrossEnvs(
  envs: Array<{ envUrl: string; dvToken: string }>,
  sourceName: string,
): Promise<UrlRecovery> {
  const name = sourceName.trim();
  // An empty or wildcard-ish name would match everything and "recover" an unrelated URL.
  if (name.length < 3) return { status: 'not-found' };

  const all = new Map<string, string>(); // url -> where it was found
  for (const env of envs) {
    const one = await queryOneEnv(env.envUrl, env.dvToken, name);
    for (const [url, from] of one) if (!all.has(url)) all.set(url, from);
  }
  if (all.size === 0) return { status: 'not-found' };
  if (all.size > 1) return { status: 'ambiguous', urls: [...all.keys()] };
  const [url, from] = [...all.entries()][0];
  logger.info({ sourceName, from }, 'recovered SharePoint url from a sibling knowledge source');
  return { status: 'recovered', url, fromSchemaName: from };
}

/** Every distinct SharePoint address stored under `name` in ONE environment. */
async function queryOneEnv(
  envUrl: string,
  dvToken: string,
  name: string,
): Promise<Map<string, string>> {
  const base = envUrl.replace(/\/$/, '');
  // OData string literals escape a single quote by doubling it; without this a source
  // named "Erik's Notes" would produce a malformed filter and a 400.
  const literal = name.replace(/'/g, "''");
  const filter = `componenttype eq 16 and name eq '${literal}'`;
  const url =
    `${base}/api/data/v9.2/botcomponents` +
    `?$select=name,schemaname,data,content&$filter=${encodeURIComponent(filter)}`;

  let rows: ComponentRow[];
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${dvToken}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
    });
    if (!res.ok) {
      logger.debug({ status: res.status, name }, 'sharepoint url recovery: query failed');
      return new Map();
    }
    rows = ((await res.json()) as { value?: ComponentRow[] }).value ?? [];
  } catch (err) {
    logger.debug({ err: (err as Error).message, name }, 'sharepoint url recovery: query error');
    return new Map();
  }

  const byUrl = new Map<string, string>(); // url -> the schemaname it came from
  for (const row of rows) {
    const found = SP_URL.exec(`${row.data ?? ''}${row.content ?? ''}`);
    if (!found) continue;
    const clean = cleanUrl(found[0]);
    if (!byUrl.has(clean)) byUrl.set(clean, row.schemaname ?? row.name ?? 'an unnamed component');
  }
  return byUrl;
}
