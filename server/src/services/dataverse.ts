import { parse as parseYaml } from 'yaml';
import { logger } from '../logger.js';
import { ComponentType } from '../types.js';
import { parseTopicGraph } from './topicGraph.js';
import { classifyKnowledgeSource, checkFileCompatibility } from './knowledgeClassifier.js';
import { resolveConnectorId, connectionAuthModeFrom } from './connectorRef.js';
import { parseToolInputs, parseOutputSchema, parseMcpBinding, parseFlowId, parseAiPluginRef, parseTopicConnectorActions } from './toolPayload.js';
import type { AgentIR, AgentPermissions, AgentSourceMetadata, AgentToolIR, AgentToolKind, ChatAccess, KnowledgeSourceIR, KnowledgeSourceMetadata, PrincipalRef, SharedPrincipal, TopicIR } from '../types.js';

/**
 * Copilot Studio extraction: reads an agent's complete definition from the
 * Dataverse Web API and builds a normalized AgentIR.
 *
 * Fidelity focus (vs. the POC): we read the REAL agent instructions from the
 * GptComponentMetadata component, parse every topic's AdaptiveDialog YAML, and
 * capture knowledge sources — instead of regex-scraping a handful of topics.
 */

const API = (url: string, path: string) => `${url}/api/data/v9.2/${path}`;

/**
 * Environments (keyed by Dataverse org url) where `bots?$select=configuration,description`
 * is known to 400. Set the first time extractAgent sees it fail; read on every
 * subsequent bot in the same run to skip the doomed combined attempt. See
 * `extractAgent`'s comment for why this is a per-environment property.
 */
const combinedSelectUnsupported = new Map<string, boolean>();

/**
 * Environments where `bots?$select=description` alone is known to 400
 * ("Could not find a property named 'description' on type '...bot'").
 * Confirmed live 2026-08-07: some Dataverse solution versions simply don't
 * have this column on `bot` at all (not a permissions or combined-select
 * issue) — once seen, skip the doomed per-bot retry for the rest of this run.
 */
const descriptionColumnUnsupported = new Map<string, boolean>();

interface BotComponent {
  botcomponentid: string;
  name: string;
  data: string | null;
  componenttype: number;
  _parentbotid_value?: string;
  /** File name for Bot File Attachment (type 14) components. */
  filedata_name?: string | null;
  /**
   * Newer-schema structured config, present on SOME componenttype-14 rows
   * that are NOT actual files — e.g. a "DataverseTableSearch" knowledge
   * source authored in Copilot Studio's modern experience. JSON, "$kind"-
   * tagged, distinct from the classic YAML `data` blob. See
   * isEmbeddedConfigSource below — found empirically via a live test tenant,
   * not from docs.
   */
  content?: string | null;
  /**
   * Native Dataverse `description` column on the component record itself —
   * NOT part of the YAML `data` blob. For system topics this holds Microsoft's
   * canned explanation; for the CustomGpt (type 15) component it holds the
   * agent's real AUTHORED description from Copilot Studio's Overview panel.
   * This is the current, authoritative source — the `bot` entity has no such
   * column in every org (see extractAgent's description fallback chain).
   */
  description?: string | null;
  // ── provenance metadata (audit trail) ──
  createdon?: string | null;
  modifiedon?: string | null;
  ismanaged?: boolean | null;
  statuscode?: number | null;
  /** Lookup to the systemuser who last modified this component — captured
   *  raw (not resolved to an email) here; resolving it costs a Dataverse
   *  call, so it's deferred until actually needed (scoping a OneDrive search
   *  to the person who added a SharePoint/OneDrive copy-mode source). See
   *  resolveSystemUserEmail below. */
  _modifiedby_value?: string | null;
  /** Dataverse schemaname for the botcomponent — used to extract the concatenated
   *  space-name key for Confluence sources (strip dotted prefix + random suffix). */
  schemaname?: string | null;
}

/** Build the provenance metadata block for a knowledge component. */
function buildKnowledgeMetadata(c: BotComponent): KnowledgeSourceMetadata {
  return {
    componentType: c.componenttype,
    createdOn: c.createdon ?? undefined,
    modifiedOn: c.modifiedon ?? undefined,
    isManaged: c.ismanaged ?? undefined,
    status: c.statuscode == null ? undefined : c.statuscode === 1 ? 'active' : 'inactive',
    modifiedByUserId: c._modifiedby_value ?? undefined,
  };
}

/**
 * Resolve a systemuser id to their email — used on demand to scope a
 * SharePoint/OneDrive search to the specific person who added a knowledge
 * source (see graphSearch.ts), never resolved eagerly for every source
 * during extraction (most sources never need it).
 */
export async function resolveSystemUserEmail(url: string, token: string, userId: string): Promise<string | null> {
  try {
    const user = await dvGet<{ internalemailaddress?: string }>(
      url,
      token,
      `systemusers(${userId})?$select=internalemailaddress`,
    );
    return user.internalemailaddress ?? null;
  } catch {
    return null;
  }
}

async function resolvePrincipalDisplay(
  url: string,
  token: string,
  id: string,
  logicalName: string,
): Promise<{ email?: string; displayName?: string; type: 'user' | 'team' | 'group' }> {
  const ln = (logicalName || '').toLowerCase();
  if (ln.includes('team')) {
    try {
      const t = await dvGet<{ name?: string }>(url, token, `teams(${id})?$select=name`);
      return { type: 'team', displayName: t.name };
    } catch {
      return { type: 'team' };
    }
  }
  try {
    const u = await dvGet<{ internalemailaddress?: string; fullname?: string }>(
      url,
      token,
      `systemusers(${id})?$select=internalemailaddress,fullname`,
    );
    return {
      type: 'user',
      email: u.internalemailaddress ?? undefined,
      displayName: u.fullname ?? undefined,
    };
  } catch {
    return { type: 'user' };
  }
}

/**
 * Resolve a bare principalobjectaccessset row's principalid when its type
 * (user vs team) isn't known up front — unlike RetrieveSharedPrincipalsAndAccess(),
 * the POA table gives no LogicalName alongside the id. GET-by-id 403s with a
 * misleading "user is not a member of the organization" for this app-user in
 * this environment (confirmed live 2026-08-21); a $filter query on the same
 * id works, so that's used instead of the GET-by-id path resolvePrincipalDisplay
 * uses above (kept as-is for the working RetrieveSharedPrincipalsAndAccess call site).
 */
async function resolvePoaPrincipal(
  url: string,
  token: string,
  id: string,
): Promise<{ email?: string; displayName?: string; type: 'user' | 'team' | 'group' }> {
  try {
    const users = await dvGet<{ value: { internalemailaddress?: string; fullname?: string }[] }>(
      url,
      token,
      `systemusers?$select=internalemailaddress,fullname&$filter=systemuserid eq ${id}`,
    );
    if (users.value[0]) {
      return { type: 'user', email: users.value[0].internalemailaddress ?? undefined, displayName: users.value[0].fullname ?? undefined };
    }
  } catch {
    /* fall through to team lookup */
  }
  try {
    const teams = await dvGet<{ value: { name?: string }[] }>(url, token, `teams?$select=name&$filter=teamid eq ${id}`);
    if (teams.value[0]) {
      return { type: 'team', displayName: teams.value[0].name };
    }
  } catch {
    /* unresolved */
  }
  return { type: 'user' };
}

/**
 * Fallback for environments where the RetrieveSharedPrincipalsAndAccess()
 * bound function isn't invokable on the `bot` entity (confirmed live
 * 2026-08-21 on a real tenant: 404 "Resource not found for the segment",
 * despite the function existing generally in $metadata — it's simply not
 * bound to this entity type here). principalobjectaccessset is the
 * underlying standard Dataverse sharing table any row-share (Editor,
 * individual chat, Agent-viewer) populates regardless of whether the
 * higher-level convenience function works, and it DOES return real data in
 * this environment.
 */
async function readSharesFromPoaTable(
  url: string,
  token: string,
  botId: string,
): Promise<{ principalid: string; accessrightsmask: unknown }[]> {
  const poa = await dvGet<{ value: { principalid: string; accessrightsmask: unknown }[] }>(
    url,
    token,
    `principalobjectaccessset?$filter=objectid eq ${botId}&$select=principalid,accessrightsmask`,
  );
  return poa.value;
}

function decodeAccessMask(mask: unknown): {
  rights: string[];
  roleHint: 'coauthor' | 'viewer' | 'custom';
  studioShareRole: 'editor' | 'agent-viewer' | 'end-user' | 'unknown';
} {
  const rights: string[] = [];
  const push = (name: string) => {
    if (!rights.includes(name)) rights.push(name);
  };
  if (typeof mask === 'string') {
    for (const part of mask.split(/[,\s]+/).filter(Boolean)) {
      const p = part.replace(/Access$/i, '');
      if (/read/i.test(p)) push('Read');
      else if (/write/i.test(p)) push('Write');
      else if (/appendto/i.test(p)) push('AppendTo');
      else if (/append/i.test(p)) push('Append');
      else if (/share/i.test(p)) push('Share');
      else if (/assign/i.test(p)) push('Assign');
      else if (/delete/i.test(p)) push('Delete');
      else push(p);
    }
  } else if (typeof mask === 'number') {
    // Dynamics AccessRights bit flags (common subset).
    if (mask & 1) push('Read');
    if (mask & 2) push('Write');
    if (mask & 4) push('Append');
    if (mask & 8) push('AppendTo');
    if (mask & 16) push('Create');
    if (mask & 32) push('Delete');
    if (mask & 262144) push('Share');
    if (mask & 524288) push('Assign');
  }
  const hasWrite = rights.some((r) => r === 'Write' || r === 'Share' || r === 'Assign' || r === 'Delete');
  const roleHint: 'coauthor' | 'viewer' | 'custom' =
    hasWrite ? 'coauthor' : rights.includes('Read') && rights.length <= 2 ? 'viewer' : rights.length ? 'custom' : 'viewer';
  // Live Copilot Studio Share dialog alignment (see docs/domain/copilot-studio-sharing.md).
  const studioShareRole: 'editor' | 'agent-viewer' | 'end-user' | 'unknown' = hasWrite
    ? 'editor'
    : rights.includes('Read')
      ? 'agent-viewer'
      : 'unknown';
  return { rights, roleHint, studioShareRole };
}

function decodeChatPolicy(code: unknown): ChatAccess['policy'] {
  const n = typeof code === 'number' ? code : Number(code);
  if (n === 0) return 'any';
  if (n === 1) return 'copilot-readers';
  if (n === 2) return 'group';
  if (n === 3) return 'any-multitenant';
  return 'unknown';
}

function parseGroupIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* fall through */
    }
    return s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Best-effort source access model for one bot: owner, record shares, chat
 * access policy. Never throws — sets `readError` when shares are unreadable
 * so we never present an empty share list as "no one has access".
 */
export async function readAgentPermissions(
  url: string,
  token: string,
  botId: string,
): Promise<AgentPermissions> {
  const empty: AgentPermissions = { sharedPrincipals: [] };
  try {
    const b = await dvGet<Record<string, unknown>>(
      url,
      token,
      `bots(${botId})?$select=_ownerid_value,accesscontrolpolicy,authorizedsecuritygroupids`,
      // Prefer formatted annotations when Dataverse returns them via Prefer header — we
      // call without Prefer; resolve owner via follow-up lookups instead.
    );

    const ownerId = (b['_ownerid_value'] as string) || undefined;
    const ownerLogical =
      (b['_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname'] as string) ||
      (b['ethan.b@example.com.V1.FormattedValue'] as string) ||
      'systemuser';

    let owner: PrincipalRef | undefined;
    if (ownerId) {
      const resolved = await resolvePrincipalDisplay(url, token, ownerId, ownerLogical);
      owner = {
        type: resolved.type,
        id: ownerId,
        email: resolved.email,
        displayName:
          resolved.displayName ??
          ((b['_ownerid_value@OData.Community.Display.V1.FormattedValue'] as string) || undefined),
      };
    }

    const policyCode = b.accesscontrolpolicy as number | undefined;
    const chatAccess: ChatAccess = {
      policy: decodeChatPolicy(policyCode),
      policyCode: typeof policyCode === 'number' ? policyCode : undefined,
      groupIds: parseGroupIds(b.authorizedsecuritygroupids),
    };

    let sharedPrincipals: SharedPrincipal[] = [];
    let readError: string | undefined;
    try {
      const shares = await dvGet<{
        PrincipalAccesses?: {
          Principal?: { Id?: string; LogicalName?: string; id?: string; logicalname?: string };
          AccessMask?: unknown;
        }[];
        // Some orgs return a flat array under value
        value?: {
          Principal?: { Id?: string; LogicalName?: string };
          AccessMask?: unknown;
        }[];
      }>(
        url,
        token,
        `bots(${botId})/Microsoft.Dynamics.CRM.RetrieveSharedPrincipalsAndAccess()`,
      );
      const rows = shares.PrincipalAccesses ?? shares.value ?? [];
      for (const row of rows) {
        const pid = row.Principal?.Id ?? (row.Principal as { id?: string } | undefined)?.id;
        const pln = row.Principal?.LogicalName ?? (row.Principal as { logicalname?: string } | undefined)?.logicalname ?? 'systemuser';
        if (!pid) continue;
        const resolved = await resolvePrincipalDisplay(url, token, pid, pln);
        const { rights, roleHint, studioShareRole } = decodeAccessMask(row.AccessMask);
        sharedPrincipals.push({
          type: resolved.type,
          id: pid,
          email: resolved.email,
          displayName: resolved.displayName,
          rights,
          roleHint,
          studioShareRole,
        });
      }
    } catch (e) {
      const msg = (e as Error).message || String(e);
      // "Resource not found for the segment" means the bound function itself isn't
      // invokable on this entity in this environment (confirmed live 2026-08-21) — not a
      // permission problem. Previously this fell into the generic classifier below, whose
      // /access/i check matched the literal word "Access" inside the function's OWN NAME
      // (RetrieveSharedPrincipalsAndAccess) and misreported it as "insufficient privilege"
      // — a false diagnosis that also meant every share on this bot silently vanished
      // instead of being read via the fallback below.
      if (/resource not found for the segment/i.test(msg)) {
        try {
          const rows = await readSharesFromPoaTable(url, token, botId);
          for (const row of rows) {
            const resolved = await resolvePoaPrincipal(url, token, row.principalid);
            const { rights, roleHint, studioShareRole } = decodeAccessMask(row.accessrightsmask);
            if (resolved.type === 'team') {
              // Confirmed live 2026-08-21: an individual Editor/chat share on a bot does
              // NOT create a direct user POA row — Dataverse auto-generates a single-record
              // team (name "{botId}_1", no teamtemplateid — it's not an Access Team Template
              // team, just an ordinary team scoped to this one share) and grants THAT team
              // the access instead. Expand to real members so the person shows up as
              // type:'user' with a real email — resolvePermissions() treats type:'team' as
              // a group and can never match it to anyone, which is how alex@filefuze.co's
              // Editor share went completely missing from a real migration's fidelity report.
              // The owner is always a member of these auto-teams too — excluded here since
              // they're already captured separately via `owner` above; reporting them again
              // as "shared" with themselves would be a duplicate, not a real finding.
              const members = await dvGet<{ value: { systemuserid: string; fullname?: string; internalemailaddress?: string }[] }>(
                url, token, `teams(${row.principalid})/teammembership_association?$select=systemuserid,fullname,internalemailaddress`,
              ).catch(() => ({ value: [] }));
              for (const m of members.value) {
                if (m.systemuserid === ownerId) continue;
                sharedPrincipals.push({
                  type: 'user',
                  id: m.systemuserid,
                  email: m.internalemailaddress,
                  displayName: m.fullname,
                  rights,
                  roleHint,
                  studioShareRole,
                });
              }
              continue;
            }
            sharedPrincipals.push({
              type: resolved.type,
              id: row.principalid,
              email: resolved.email,
              displayName: resolved.displayName,
              rights,
              roleHint,
              studioShareRole,
            });
          }
        } catch (poaErr) {
          readError = `shares not readable via RetrieveSharedPrincipalsAndAccess (unbound on this entity) or principalobjectaccessset fallback: ${(poaErr as Error).message?.slice(0, 200)}`;
          sharedPrincipals = [];
        }
      } else if (/\(403\)|\(401\)/i.test(msg)) {
        readError = 'shares not readable (insufficient app-user privilege)';
        sharedPrincipals = [];
      } else {
        readError = `shares not readable: ${msg.slice(0, 200)}`;
        sharedPrincipals = [];
      }
    }

    return { owner, sharedPrincipals, chatAccess, readError };
  } catch (e) {
    logger.warn(`readAgentPermissions failed for ${botId}: ${(e as Error).message}`);
    return {
      ...empty,
      readError: `permissions not readable: ${(e as Error).message?.slice(0, 200) ?? 'unknown'}`,
    };
  }
}

async function dvGet<T>(url: string, token: string, path: string): Promise<T> {
  const res = await fetch(API(url, path), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    // Surface Dataverse's own OData error message (e.g. "Could not find a
    // property named 'description' on type...") instead of a bare status
    // code — a bare "(400)" gives no way to tell a bad $select from a real
    // outage without re-running the request by hand.
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? '';
    } catch {
      /* body wasn't JSON (or already consumed) — fall back to bare status */
    }
    throw new Error(`Dataverse GET ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

export interface BotSummary {
  botid: string;
  name: string;
  /** Best-effort owner systemuserid / team id. */
  ownerId?: string;
  ownerEmail?: string;
  ownerDisplayName?: string;
  /** Decoded chat access policy label for Select Agents UI. */
  accessLabel?: string;
  accessPolicy?: string;
}

/**
 * Download the raw bytes of a Bot File Attachment (componenttype 14) via its
 * `filedata` File column. This is step 1 of knowledge execution — the actual
 * "get the uploaded file" call. Dataverse serves File columns from
 * `…/botcomponents(<id>)/filedata/$value`. Returns null on failure (e.g. the
 * component has no file, or access is denied).
 */
export async function fetchFileAttachmentBytes(
  url: string,
  token: string,
  botcomponentId: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const res = await fetch(`${url}/api/data/v9.2/botcomponents(${botcomponentId})/filedata/$value`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    logger.warn(`filedata download for ${botcomponentId} failed (${res.status})`);
    return null;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
}

// ── AI Builder prompt resolution ────────────────────────────────────────────
// Prebuilt Dynamics agents put their real logic in AI Builder models that
// topics invoke via InvokeAIBuilderModelAction (aIModelId: <guid>). The prompt
// text lives in msdyn_aiconfigurations.msdyn_customconfiguration as a
// "GptDynamicPrompt" (prompt[] of literal/inputVariable/formula parts). We
// resolve model-id → prompt text so the migrated Gemini agent carries the real
// instructions instead of an empty shell.  (Mirrors the teammate POC.)

interface AiPromptEntry { name: string; prompt: string }

/** Flatten a GptDynamicPrompt JSON string into readable prompt text. */
function parseGptDynamicPrompt(raw: string | null | undefined): string {
  if (!raw) return '';
  let cfg: unknown;
  try { cfg = JSON.parse(raw); } catch { return ''; }
  if (Array.isArray(cfg)) cfg = cfg[0] ?? {};
  const parts = (cfg as { prompt?: unknown[] })?.prompt;
  if (!Array.isArray(parts)) return '';
  const out: string[] = [];
  for (const p of parts as Record<string, unknown>[]) {
    switch (p.type) {
      case 'literal': out.push(String(p.text ?? '')); break;
      case 'inputVariable': out.push(`{${String(p.id ?? 'var')}}`); break;
      case 'formula': out.push(`[${String(p.expression ?? 'formula')}]`); break;
      case 'dataSource': out.push(`[DATA:${String(p.id ?? 'ds')}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * Follow @odata.nextLink pages, collecting all rows.
 *
 * Use this, not `dvGet`, for any list that a real tenant can grow past a page.
 * A single `dvGet` with `$top=N` truncates SILENTLY at N — Dataverse returns 200
 * with N rows and no indication there were more, which in extraction means an
 * agent quietly loses topics or tools and the fidelity report calls it a success.
 */
async function dvGetAll<T>(url: string, token: string, path: string): Promise<T[]> {
  const rows: T[] = [];
  let next: string | null = API(url, path);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=500' };
  while (next) {
    const res = await fetch(next, { headers });
    if (!res.ok) {
      // Same reasoning as dvGet: a bare status hides which $select Dataverse rejected.
      let detail = '';
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? '';
      } catch {
        /* body wasn't JSON — fall back to bare status */
      }
      throw new Error(`Dataverse GET ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    const json = (await res.json()) as { value?: T[]; '@odata.nextLink'?: string };
    rows.push(...(json.value ?? []));
    next = json['@odata.nextLink'] ?? null;
  }
  return rows;
}

// One AI-prompt map per environment (built once, then reused across agents).
const aiPromptMapCache = new Map<string, Promise<Map<string, AiPromptEntry>>>();

async function buildAiPromptMap(url: string, token: string): Promise<Map<string, AiPromptEntry>> {
  const map = new Map<string, AiPromptEntry>();
  // model id → name
  const nameById = new Map<string, string>();
  try {
    const models = await dvGetAll<{ msdyn_aimodelid: string; msdyn_name: string }>(
      url, token, 'msdyn_aimodels?$select=msdyn_aimodelid,msdyn_name',
    );
    for (const m of models) nameById.set(m.msdyn_aimodelid, m.msdyn_name);
  } catch (e) {
    logger.warn(`AI models query failed (non-fatal): ${(e as Error).message}`);
  }
  // configurations → prompt text (prefer published statecode, then most recent)
  try {
    const cfgs = await dvGetAll<{
      _msdyn_aimodelid_value: string;
      msdyn_customconfiguration: string | null;
      statecode: number;
      createdon: string;
    }>(
      url, token,
      'msdyn_aiconfigurations?$select=_msdyn_aimodelid_value,msdyn_customconfiguration,statecode,createdon',
    );
    const byModel = new Map<string, typeof cfgs>();
    for (const c of cfgs) {
      const mid = c._msdyn_aimodelid_value;
      if (!mid) continue;
      (byModel.get(mid) ?? byModel.set(mid, []).get(mid)!).push(c);
    }
    for (const [mid, list] of byModel) {
      list.sort((a, b) => Number(b.statecode === 1) - Number(a.statecode === 1) || (b.createdon ?? '').localeCompare(a.createdon ?? ''));
      const prompt = parseGptDynamicPrompt(list[0].msdyn_customconfiguration);
      if (prompt) map.set(mid, { name: nameById.get(mid) ?? 'AI Builder model', prompt });
    }
  } catch (e) {
    logger.warn(`AI configurations query failed (non-fatal): ${(e as Error).message}`);
  }
  logger.info({ env: url, resolvedPrompts: map.size }, 'built AI Builder prompt map');
  return map;
}

/** Memoized per-environment AI Builder prompt map. */
export function getAiPromptMap(url: string, token: string): Promise<Map<string, AiPromptEntry>> {
  let p = aiPromptMapCache.get(url);
  if (!p) { p = buildAiPromptMap(url, token); aiPromptMapCache.set(url, p); }
  return p;
}

/** List all active agents (bots) in the environment (includes lightweight owner/access). */
export async function listBots(url: string, token: string): Promise<BotSummary[]> {
  const json = await dvGet<{
    value: {
      botid: string;
      name: string;
      _ownerid_value?: string;
      accesscontrolpolicy?: number;
      '_ownerid_value@OData.Community.Display.V1.FormattedValue'?: string;
    }[];
  }>(
    url,
    token,
    'bots?$select=name,botid,_ownerid_value,accesscontrolpolicy&$filter=statecode eq 0',
  );
  const rows = json.value ?? [];
  const out: BotSummary[] = [];
  // Resolve a small unique set of owners (cap lookups to keep list snappy).
  const ownerCache = new Map<string, { email?: string; displayName?: string }>();
  for (const b of rows) {
    const policy = decodeChatPolicy(b.accesscontrolpolicy);
    const accessLabel =
      policy === 'any' || policy === 'any-multitenant'
        ? 'Org-wide'
        : policy === 'group' || policy === 'copilot-readers'
          ? 'Group'
          : policy === 'unknown'
            ? 'Unknown'
            : 'Private';
    let ownerEmail: string | undefined;
    let ownerDisplayName =
      b['_ownerid_value@OData.Community.Display.V1.FormattedValue'] || undefined;
    if (b._ownerid_value) {
      let cached = ownerCache.get(b._ownerid_value);
      if (!cached && ownerCache.size < 40) {
        try {
          const resolved = await resolvePrincipalDisplay(url, token, b._ownerid_value, 'systemuser');
          cached = { email: resolved.email, displayName: resolved.displayName };
          ownerCache.set(b._ownerid_value, cached);
        } catch {
          ownerCache.set(b._ownerid_value, {});
          cached = {};
        }
      }
      ownerEmail = cached?.email;
      ownerDisplayName = cached?.displayName || ownerDisplayName;
    }
    out.push({
      botid: b.botid,
      name: b.name,
      ownerId: b._ownerid_value,
      ownerEmail,
      ownerDisplayName,
      accessLabel,
      accessPolicy: policy,
    });
  }
  return out;
}

/** Safe YAML parse that never throws — returns null on malformed input. */
function tryParseYaml(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = parseYaml(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const SYSTEM_TOPIC_NAMES = new Set([
  'Conversation Start',
  'Conversational boosting',
  'Fallback',
  'Escalate',
  'End of Conversation',
  'Goodbye',
  'Start Over',
  'Reset Conversation',
  'Multiple Topics Matched',
  'On Error',
  'Signin',
]);

/**
 * Strip unresolved Copilot Studio / Power Fx expressions so they don't leak
 * into the Gemini agent as meaningless tokens. Removes:
 *   - handlebars-style bindings:  {Topic.Summary.text}, {x.y}
 *   - Power Fx / expression refs:  =System.Activity.Text, =Global.var
 * Returns '' when the text is nothing but a binding (so callers can skip it).
 */
export function stripBindings(text: string | undefined): string {
  if (!text) return '';
  let out = text
    .replace(/\{[^{}]*\}/g, ' ') // {Topic.Summary.text}
    .replace(/=\s*[A-Za-z_][\w.]*(\([^)]*\))?/g, ' ') // =System.Activity.Text, =Foo()
    .replace(/\s{2,}/g, ' ')
    .trim();
  // If what's left is empty or just punctuation, treat as no content.
  if (!out || !/[A-Za-z0-9]/.test(out)) return '';
  return out;
}

/** Recursively collect string values for keys matching a predicate. */
function collectStrings(node: unknown, keyMatch: (k: string) => boolean, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, keyMatch, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (keyMatch(k) && typeof v === 'string' && v.trim()) out.push(v.trim());
      collectStrings(v, keyMatch, out);
    }
  }
}

/** Parse one topic's AdaptiveDialog YAML into a TopicIR. */
/**
 * Is this componenttype-9 row a TOOL rather than a topic?
 *
 * Copilot Studio files both under the same component type and separates them by the
 * `kind:` on the first meaningful line of `data`: `AdaptiveDialog` for an authored
 * topic, `TaskDialog` for something the agent can invoke.
 */
/**
 * Which componenttype-9 rows are TOOLS rather than topics.
 *
 * `TaskDialog` was the only shape recognised. Copilot Studio also writes a flatter
 * `ConnectorTool` row — measured 2026-08-12, 5 rows across 2 agents in the test tenant,
 * including one ("Hubspot agentt") whose ENTIRE content is four ConnectorTool rows. Not
 * matching meant no tool, no note, and `thinContent: true`: the product told the customer
 * there was nothing authored to migrate about an agent built entirely out of HubSpot calls.
 * A false all-clear, which is the one outcome this pipeline exists to prevent.
 */
function isAgentToolComponent(c: BotComponent): boolean {
  const data = c.data || c.content || '';
  return /^\s*kind:\s*(TaskDialog|ConnectorTool)\s*$/m.test(data);
}

/** A componenttype-9 row that is a named sub-agent with its own instructions. */
function isInlineSkillComponent(c: BotComponent): boolean {
  return /^\s*kind:\s*InlineAgentSkill\s*$/m.test(c.data || c.content || '');
}

// connectorIdFromConnectionReference / connectionAuthModeFrom moved to
// services/connectorRef.ts — they are pure, this module is not (it pulls in the fail-fast
// config), and that was the only thing stopping them from being unit-tested.

const TASK_ACTION_KIND: Record<string, AgentToolKind> = {
  invokeconnectortaskaction: 'connector',
  invokeexternalagenttaskaction: 'mcp-server',
  invokeconnectedagenttaskaction: 'connected-agent',
  invokeaibuildermodeltaskaction: 'ai-builder',
  // Both were previously absent, so every custom API and every flow-backed tool in the
  // tenant parsed as 'unknown' — 11 of 63 tools in the live census (ledger 1.12).
  invokeaiplugintaskaction: 'ai-plugin',
  invokeflowtaskaction: 'flow',
};

/**
 * Parse one TaskDialog component into an AgentToolIR.
 *
 * Read with targeted regexes rather than a YAML parse for the same reason the topic
 * parser does: these bodies are Copilot's own dialect and a strict parse throws on
 * shapes we have not seen, which would drop the whole tool. An unrecognised action
 * kind is preserved as 'unknown' — never discarded.
 */
/**
 * The flat `ConnectorTool` row shape:
 *
 *     kind: ConnectorTool
 *     authMode: Invoker
 *     connectionReference: cr88d_hubspotagentt_XSK2Qk.cr.shared_get-20crm-…
 *     connectorId: /providers/Microsoft.PowerApps/apis/shared_get-20crm-…
 *     operationId: GetDeals
 *
 * Everything a bound call needs is stated outright — no nested action, no binding block.
 * The ARM `connectorId` is authoritative, so these need none of the inference the
 * TaskDialog and topic-embedded shapes do. Inputs are absent because the author pinned
 * nothing: every argument is the model's to supply, which is exactly what the binder
 * defaults to.
 */
function parseConnectorToolRow(c: BotComponent): AgentToolIR {
  const data = c.data || c.content || '';
  const armPath = /^\s*connectorId:\s*(\S+)\s*$/m.exec(data)?.[1];
  const connectionReference = /^\s*connectionReference:\s*(\S+)\s*$/m.exec(data)?.[1];
  const operationId = /^\s*operationId:\s*(\S+)\s*$/m.exec(data)?.[1] || undefined;
  return {
    name: c.name ?? '(unnamed tool)',
    kind: 'connector',
    displayName: /^\s*modelDisplayName:\s*(.+)$/m.exec(data)?.[1]?.trim() || c.name || undefined,
    description: /^\s*modelDescription:\s*(.+)$/m.exec(data)?.[1]?.trim() || undefined,
    connectorId: resolveConnectorId(connectionReference, operationId, armPath).connectorId,
    connectionAuthMode: connectionAuthModeFrom(data),
    operationId,
    schemaName: c.schemaname ?? undefined,
  };
}

function parseAgentTool(c: BotComponent): AgentToolIR {
  const data = c.data || c.content || '';
  if (/^\s*kind:\s*ConnectorTool\s*$/m.test(data)) return parseConnectorToolRow(c);
  const rawKind = /^\s*kind:\s*(Invoke\w*TaskAction)\s*$/m.exec(data)?.[1] ?? '';
  const connectionReference = /^\s*connectionReference:\s*(\S+)\s*$/m.exec(data)?.[1] ?? '';
  const outputs = [...data.matchAll(/^\s*-\s*propertyName:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  // Everything the author BOUND, not just what the tool is. Parsed in toolPayload.ts so it
  // can be unit-tested; see the module header for why it scans instead of loading YAML.
  const inputs = parseToolInputs(data);
  const outputSchema = parseOutputSchema(data);
  const mcp = parseMcpBinding(data);
  const flowId = parseFlowId(data);
  const aiPlugin = parseAiPluginRef(data);
  const operationId = /^\s*operationId:\s*(\S+)\s*$/m.exec(data)?.[1] || undefined;
  return {
    name: c.name ?? '(unnamed tool)',
    kind: TASK_ACTION_KIND[rawKind.toLowerCase()] ?? 'unknown',
    displayName: /^\s*modelDisplayName:\s*(.+)$/m.exec(data)?.[1]?.trim() || undefined,
    description: /^\s*modelDescription:\s*(.+)$/m.exec(data)?.[1]?.trim() || undefined,
    connectorId: resolveConnectorId(connectionReference || undefined, operationId).connectorId,
    connectionAuthMode: connectionAuthModeFrom(data),
    operationId,
    outputs: outputs.length ? outputs : undefined,
    inputs: inputs.length ? inputs : undefined,
    outputSchema: outputSchema.length ? outputSchema : undefined,
    mcp,
    flowId,
    aiPlugin,
    schemaName: c.schemaname ?? undefined,
  };
}

function parseTopic(c: BotComponent): TopicIR {
  const raw = c.data ?? '';
  const doc = tryParseYaml(raw);

  const triggerPhrases: string[] = [];
  const messages: string[] = [];

  if (doc) {
    // Trigger phrases live under beginDialog.intent.triggerQueries (or similar).
    collectStrings(doc, (k) => k === 'triggerQueries', triggerPhrases);
    // Message activities: SendActivity nodes carry an `activity` string.
    collectStrings(doc, (k) => k === 'activity', messages);
  }

  // Fallback: pull "- phrase" bullet lines from the head of the raw YAML.
  if (triggerPhrases.length === 0 && raw) {
    for (const m of raw.slice(0, 800).matchAll(/^\s*-\s+(.{3,80})$/gm)) {
      const phrase = m[1].trim();
      if (phrase && !phrase.includes(':')) triggerPhrases.push(phrase);
    }
  }

  const usesAiBuilder = raw.includes('InvokeAIBuilderModelAction') || raw.includes('aIModelId');
  const usesAdaptiveCards = raw.includes('AdaptiveCard') || raw.includes('application/vnd.microsoft.card');

  // modelDescription is the topic's plain-English "what this does" — the most
  // reliable human-readable content. Also read topic-level `description`.
  const mdOut: string[] = [];
  const descOut: string[] = [];
  if (doc) {
    collectStrings(doc, (k) => k === 'modelDescription', mdOut);
    collectStrings(doc, (k) => k === 'description', descOut);
  }
  const modelDescription = (mdOut[0] || descOut[0] || '').replace(/\s+/g, ' ').trim();

  // Summary: prefer modelDescription (clean prose) → additionalInstructions →
  // a message with its bindings stripped. Never emit a bare {binding}.
  const instr: string[] = [];
  if (doc) collectStrings(doc, (k) => k === 'additionalInstructions', instr);
  let summary = '';
  if (modelDescription) summary = modelDescription.slice(0, 400);
  else if (instr.length) summary = stripBindings(instr[0]).slice(0, 400);
  else if (messages.length) summary = stripBindings(messages[0]).slice(0, 200);

  const graph = parseTopicGraph(raw);
  // Prefer graph-derived trigger phrases when available.
  if (graph.trigger.phrases.length) {
    for (const p of graph.trigger.phrases) triggerPhrases.push(p);
  }

  return {
    id: c.botcomponentid,
    name: c.name,
    raw,
    triggerPhrases: dedupe(triggerPhrases).slice(0, 25),
    modelDescription: modelDescription || undefined,
    summary,
    messages: dedupe(messages.map((m) => stripBindings(m)).filter(Boolean)).slice(0, 10),
    usesAiBuilder,
    usesAdaptiveCards,
    isSystem: SYSTEM_TOPIC_NAMES.has(c.name),
    graph,
  };
}

/**
 * `kind: InlineAgentSkill` → a TopicIR, because that is what it is.
 *
 * The row wraps a markdown document with YAML front matter:
 *
 *     kind: InlineAgentSkill
 *     content: |-
 *       ---
 *       name: query-hubspot-crm
 *       description: |-
 *         Looks up existing HubSpot contacts, companies, deals, or tickets…
 *       ---
 *       You are the HubSpot CRM Assistant for CloudFuze employees.
 *       ROLE …  SCOPE …  TONE …  OUT OF SCOPE …
 *
 * That body is a named sub-agent's INSTRUCTIONS — the richest authored content on
 * "Hubspot agentt", and the reason its `instructions: 0` reading was so misleading: the
 * behaviour is here, not in GptComponentMetadata. It carries the read-only constraint and
 * the explicit "you cannot run live counts" refusal, so dropping it would migrate an agent
 * that keeps the capability and loses every guard rail the author put on it.
 *
 * Mapped onto TopicIR rather than a new IR field on purpose: a named unit with a
 * description and instructions is exactly what the ADK deployer already turns into a topic
 * sub-agent, and changing the IR shape needs Architect sign-off (architecture-boundaries).
 */
function parseInlineSkill(c: BotComponent): TopicIR {
  const raw = c.data || c.content || '';
  // `content: |-` then an indented block. Strip the YAML key and de-indent.
  const block = /^\s*content:\s*\|-?\s*\n([\s\S]*)$/m.exec(raw)?.[1] ?? raw;
  const indent = /^([ \t]*)\S/m.exec(block)?.[1] ?? '';
  const body = indent ? block.replace(new RegExp(`^${indent}`, 'gm'), '') : block;

  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(body);
  const front = fm?.[1] ?? '';
  const instructions = (fm ? body.slice(fm[0].length) : body)
    // A Copilot authoring marker, not content.
    .replace(/^\s*<!--\s*bic:[^>]*-->\s*$/gm, '')
    .trim();

  const name = /^\s*name:\s*(.+)$/m.exec(front)?.[1]?.trim() || c.name || '(unnamed skill)';
  // `description: |-` block, else a single-line description.
  const descBlock = /^\s*description:\s*\|-?\s*\n([\s\S]*?)(?=\n\s*\w+:|$)/m.exec(front)?.[1];
  const description = (descBlock ?? /^\s*description:\s*(.+)$/m.exec(front)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    id: c.botcomponentid,
    name,
    raw,
    triggerPhrases: [],
    modelDescription: description || undefined,
    // The instructions ARE the summary here — this is what the sub-agent must be told.
    summary: instructions.slice(0, 4000),
    messages: [],
    usesAiBuilder: false,
    usesAdaptiveCards: false,
    isSystem: false,
    graph: parseTopicGraph(raw),
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}

const GREETING =
  /^(hi|hey|hello|yo|thanks?|thank you|thx|bye|goodbye|good (morning|afternoon|evening|day)|ok(ay)?|yes|no|start|help)\b/i;

/** A trigger phrase makes a good starter prompt if it's a real request, not a pleasantry. */
function isUsefulStarter(phrase: string): boolean {
  const p = phrase.trim();
  return p.length >= 12 && !GREETING.test(p);
}

/** Parse the GptComponentMetadata component that holds the real agent config. */
function parseGptMetadata(c: BotComponent): {
  instructions: string;
  description: string;
  capabilities: { webBrowsing: boolean; codeInterpreter: boolean };
  starterPrompts: string[];
} {
  const doc = tryParseYaml(c.data);
  const instructions = typeof doc?.instructions === 'string' ? doc.instructions.trim() : '';
  const description = typeof doc?.description === 'string' ? doc.description.trim() : '';
  const caps = (doc?.gptCapabilities ?? {}) as { webBrowsing?: boolean; codeInterpreter?: boolean };

  const starterPrompts: string[] = [];
  // Conversation starters may appear under a few different keys across versions.
  if (doc) {
    collectStrings(
      doc,
      (k) => /conversationstarter|suggestedprompt|starterprompt/i.test(k),
      starterPrompts,
    );
  }

  return {
    instructions,
    description,
    capabilities: {
      webBrowsing: Boolean(caps.webBrowsing),
      codeInterpreter: Boolean(caps.codeInterpreter),
    },
    starterPrompts: dedupe(starterPrompts).slice(0, 6),
  };
}

/**
 * Some componenttype 14 (BotFileAttachment) rows aren't real files — they
 * carry a structured knowledge-source config in the `content` column (JSON,
 * "$kind"-tagged — Copilot's newer authoring schema, distinct from the
 * classic YAML `data` blob type-16 sources use in parseKnowledgeSource
 * below). Confirmed on a live test tenant: a "Dataverse table search"
 * knowledge source showed up exactly this way, with filedata/filedata_name
 * both null — parseFileAttachment would otherwise try to fetch bytes that
 * don't exist. Route these through the knowledge-source path instead.
 */
function isEmbeddedConfigSource(c: BotComponent): boolean {
  return !c.filedata_name && Boolean(c.content) && /"\$kind"\s*:\s*"KnowledgeSourceComponent"/.test(c.content ?? '');
}

function parseEmbeddedConfigSource(c: BotComponent): KnowledgeSourceIR {
  let doc: Record<string, unknown> | null = null;
  try {
    doc = JSON.parse(c.content ?? '{}') as Record<string, unknown>;
  } catch {
    /* keep null — falls through to Unknown/manual-review below */
  }

  // The data source entry's own "$kind" (e.g. "DataverseTableSearch") is the
  // real classification signal — "KnowledgeSourceComponent" is just the
  // wrapper every one of these rows shares.
  const dataSources = (doc?.dataSources as { $kind?: string }[] | undefined) ?? [];
  const kind = dataSources[0]?.$kind ?? 'Unknown';

  const refs: string[] = [];
  if (doc) collectStrings(doc, (k) => /url|site|siteurl|reference|entity|path|connection/i.test(k), refs);
  const references = dedupe(refs);

  const classification = classifyKnowledgeSource({ kind, references });
  return {
    id: c.botcomponentid,
    name: c.name,
    kind,
    reference: references[0],
    references,
    classification,
    metadata: buildKnowledgeMetadata(c),
    raw: doc ?? c.content ?? undefined,
  };
}

function parseKnowledgeSource(c: BotComponent): KnowledgeSourceIR {
  const doc = tryParseYaml(c.data);
  // The real distinguishing type lives at `source.kind` — the top-level
  // `kind` is ALWAYS the literal string "KnowledgeSourceConfiguration" for
  // every knowledge source in this schema (website, SharePoint, Dataverse,
  // all of them), confirmed against live tenant data. Reading top-level
  // `kind` alone (the prior behavior) meant every classic-schema source fell
  // through classification's kind-based rules entirely, relying only on the
  // reference-URL inference fallback to guess a strategy.
  const source = doc?.source as { kind?: string } | undefined;
  const kind = source?.kind ?? (doc?.kind as string) ?? (doc?.knowledgeSourceType as string) ?? 'Unknown';

  // All references (URLs, site paths, entity/skill names) — not just the
  // first. "skill" added after finding Dataverse/federated sources identify
  // themselves via `skillConfiguration: <name>` rather than a URL — captured
  // here for visibility even though what a skillConfiguration name resolves
  // to is not yet verified (see knowledgeClassifier.ts notes for this gap).
  const refs: string[] = [];
  if (doc) collectStrings(doc, (k) => /url|site|siteurl|reference|entity|path|connection|skill/i.test(k), refs);
  const references = dedupe(refs);

  // Author's description of what this source is for — used in the classifier and
  // folded into the Gemini agent's instruction for website sources.
  // Two sources: (a) YAML `data` blob (`doc.description`) for older-schema sources;
  // (b) Dataverse `description` column (`c.description`) for Confluence and newer
  // sources — it's the authoritative field for identifying Confluence knowledge sources.
  const descRaw = (c.description ?? (doc?.description as string) ?? '').trim();
  const description = descRaw ? descRaw.slice(0, 500) : undefined;

  // Uploaded-file metadata, when this source is a file. The actual bytes live in
  // Dataverse and are pulled at migration time; here we capture name/size so the
  // classifier can apply Gemini's format/size ingest gate up front.
  let file: KnowledgeSourceIR['file'];
  if (doc) {
    const names: string[] = [];
    collectStrings(doc, (k) => /filename|displayname|documentname/i.test(k), names);
    const fileName = names.find((n) => n.includes('.')) ?? names[0];
    const sizeStr: string[] = [];
    collectStrings(doc, (k) => /size|bytes|filesize|length/i.test(k), sizeStr);
    const sizeBytes = sizeStr.map((s) => Number(s)).find((n) => Number.isFinite(n) && n > 0);
    if (fileName || sizeBytes) file = { name: fileName ? normalizeFileName(fileName) : fileName, sizeBytes };
  }

  const classification = classifyKnowledgeSource({ kind, references, file, description });

  // Reflect the file-compat gate back onto the file record for the report.
  if (file?.name) {
    const compat = checkFileCompatibility(file.name, file.sizeBytes);
    file = {
      ...file,
      format: compat.format,
      compatible: compat.compatible,
      incompatReason: compat.reason,
    };
  }

  // Confluence sources — capture ALL available signals for cross-referencing space names.
  // No single field is 100% reliable alone:
  //   c.description  → "…Confluence items: SpaceA, SpaceB" (best for comma-separated names)
  //   c.name         → EDITOR-SET label; may be space names or anything the author typed
  //   skillConfig    → "SpaceASpaceB_<randomId>" (auto-generated, stable, but no word boundaries)
  //   schemaname     → dotted prefix + same concatenated key as skillConfig
  // Space IDs (UUID_{numeric}) are NOT present in Dataverse at all.
  // Detection: kind=FederatedStructuredSearchSource + description contains "confluence".
  let confluenceSpaceNames: string[] | undefined;
  let confluenceSkillConfig: string | undefined;
  let confluenceComponentName: string | undefined;
  let confluenceSchemaName: string | undefined;
  const rowDesc = (c.description ?? '').trim();
  const isConfluenceSource =
    /confluence/i.test(kind) ||
    (kind === 'FederatedStructuredSearchSource' && rowDesc.toLowerCase().includes('confluence'));
  if (isConfluenceSource) {
    // Signal 1: description → comma-separated space names (most actionable for CQL)
    const m = rowDesc.match(/confluence items:\s*(.+)$/i);
    if (m) {
      const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length > 0) confluenceSpaceNames = names;
    }

    // Signal 2: YAML source.skillConfiguration — stable auto-generated key
    const srcBlock = doc?.source as Record<string, unknown> | undefined;
    const sc = srcBlock?.skillConfiguration;
    if (typeof sc === 'string' && sc) confluenceSkillConfig = sc;

    // Signal 3: botcomponent name — may be space names or a custom user label
    if (c.name) confluenceComponentName = c.name;

    // Signal 4: schemaname — strip dotted type prefix + trailing random suffix
    // "crf37_Agent.topic.SpaceASpaceB_QfXXbkQ3xcN5Bw9598KB0" → "SpaceASpaceB"
    if (c.schemaname) {
      const last = c.schemaname.split('.').pop() ?? '';
      // Suffix is always pure alphanumeric, 15+ chars; schemaname suffix never contains '_'
      const stripped = last.replace(/_[A-Za-z0-9]{15,}$/, '');
      if (stripped && stripped !== last) confluenceSchemaName = stripped;
    }
  }

  return {
    id: c.botcomponentid,
    name: c.name,
    kind,
    reference: references[0],
    references,
    description,
    file,
    confluenceSpaceNames,
    confluenceSkillConfig,
    confluenceComponentName,
    confluenceSchemaName,
    classification,
    metadata: buildKnowledgeMetadata(c),
    raw: doc ?? c.data ?? undefined,
  };
}

/**
 * Dataverse sometimes stores a file's display name already percent-encoded
 * (e.g. "Foo%20Bar.pdf" for the real name "Foo Bar.pdf") — a quirk of how the
 * source system persisted it, not something we control. Decode it back to the
 * real literal name here, ONCE, at extraction time, so nothing downstream
 * (the compat gate, idempotency-by-filename, MIME lookup, the actual upload)
 * re-encodes an already-encoded name into a corrupted double-encoded one.
 * Confirmed live: an unfixed name produced "%20" → "%2520" on upload.
 */
function normalizeFileName(name: string): string {
  try {
    const decoded = decodeURIComponent(name);
    return decoded !== name ? decoded : name;
  } catch {
    return name; // not validly percent-encoded — treat as a literal name that happens to contain '%'
  }
}

/**
 * Parse a Bot File Attachment (componenttype 14) — an author-uploaded knowledge
 * file. The bytes live in the `filedata` File column (fetched separately at
 * migration time via …/filedata/$value); here we capture the name so the
 * classifier can apply Gemini's format/size ingest gate.
 */
function parseFileAttachment(c: BotComponent): KnowledgeSourceIR {
  const fileName = normalizeFileName((c.filedata_name || c.name || 'file').trim());
  const compat = checkFileCompatibility(fileName);
  const file = { name: fileName, format: compat.format, compatible: compat.compatible, incompatReason: compat.reason };
  const classification = classifyKnowledgeSource({ kind: 'FileUpload', file: { name: fileName } });
  return { id: c.botcomponentid, name: fileName, kind: 'FileUpload', file, classification, metadata: buildKnowledgeMetadata(c) };
}

/**
 * Pull the classic-experience authored description out of a bot's raw
 * `configuration` JSON blob (settings["default-2.1.0"].content.description).
 * The version key varies by experience, so scan any settings entry for a
 * content.description rather than pinning one version.
 */
/**
 * Agent-level settings from the NEWER authoring surface, which keeps them on
 * `bot.configuration.agentSettings` rather than in a GptComponentMetadata component:
 *
 *     "agentSettings": {
 *       "model":        { "series": "claude-opus-5" },
 *       "instructions": {},
 *       "enableMemory": true,
 *       "web":          { "enableWebSearch": true }
 *     }
 *
 * "Hubspot agentt" has NO type-15 component at all, so `capabilities.webBrowsing` fell back
 * to false and extraction reported web browsing off for an agent whose Knowledge panel
 * plainly reads "Search all websites". Reporting a capability as absent is not a neutral
 * default — the fidelity report then has nothing to say about losing it, so the customer is
 * told the migration was complete when a whole grounding source was dropped in silence.
 *
 * `enableMemory` matters for the same reason: memory migration cannot warn about memory it
 * does not know is switched on.
 */
function parseAgentSettings(configuration?: string): {
  webSearch?: boolean;
  memoryEnabled?: boolean;
  modelSeries?: string;
} {
  if (!configuration) return {};
  try {
    const cfg = JSON.parse(configuration) as {
      agentSettings?: {
        web?: { enableWebSearch?: boolean };
        enableMemory?: boolean;
        model?: { series?: string };
      };
    };
    const s = cfg.agentSettings;
    if (!s) return {};
    return {
      webSearch: typeof s.web?.enableWebSearch === 'boolean' ? s.web.enableWebSearch : undefined,
      memoryEnabled: typeof s.enableMemory === 'boolean' ? s.enableMemory : undefined,
      modelSeries: typeof s.model?.series === 'string' ? s.model.series : undefined,
    };
  } catch {
    // A configuration blob we cannot parse is not a reason to fail extraction.
    return {};
  }
}

function parseConfigDescription(configuration?: string): string {
  const cfg = configuration ? (JSON.parse(configuration) as Record<string, unknown>) : null;
  const settings = (cfg?.settings ?? {}) as Record<string, { content?: { description?: string } }>;
  const content = settings['default-2.1.0']?.content
    ?? Object.values(settings).find((s) => s?.content?.description)?.content;
  return content?.description ? String(content.description).trim() : '';
}

/**
 * A verbatim copy of what Dataverse returned for one agent, handed out before any parsing.
 *
 * Passed OUT rather than persisted here on purpose: services do not talk to repos in this
 * codebase (see .claude/rules/architecture-boundaries.md), so the orchestrator owns the
 * write and `dataverse.ts` stays a pure extractor with no database dependency.
 */
export interface RawAgentPayload {
  sourceId: string;
  sourceName: string;
  envUrl: string;
  components: unknown[];
  botRecord?: Record<string, unknown>;
  disabledComponentNames: string[];
}

/**
 * Extract one agent into a complete AgentIR. Pulls all components for the bot
 * in a single query, then partitions by type.
 *
 * `onRaw`, when supplied, receives the untouched payload before parsing. It is how the
 * caller lands raw data for blind-spot analysis (see db/repos/rawAgents.ts) without this
 * module knowing that a database exists. It is called for its side effect only; anything
 * it throws is swallowed, because a diagnostic sink must never fail an extraction.
 */
export async function extractAgent(
  url: string,
  token: string,
  bot: BotSummary,
  onRaw?: (raw: RawAgentPayload) => void,
): Promise<AgentIR> {
  // Paged, not $top=1000: an agent with more components than the cap would have had the
  // remainder dropped without any error, and every downstream count (topics, tools,
  // knowledge) would be wrong while still reporting success.
  const components = await dvGetAll<BotComponent>(
    url,
    token,
    'botcomponents?$select=name,data,content,componenttype,_parentbotid_value,filedata_name,createdon,modifiedon,ismanaged,statuscode,description,_modifiedby_value,schemaname' +
      `&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid}`,
  );

  // The fetch above deliberately takes only `statecode eq 0`. Ask separately for what was
  // left behind so the report can name it — a disabled tool looks identical to a missing
  // one when you are comparing the two platforms side by side. Best-effort and cheap
  // (names only): failing to list them must never fail the extraction.
  let disabledComponentNames: string[] = [];
  try {
    const disabled = await dvGetAll<{ name?: string }>(
      url,
      token,
      'botcomponents?$select=name,componenttype' +
        `&$filter=statecode ne 0 and _parentbotid_value eq ${bot.botid}`,
    );
    disabledComponentNames = disabled.map((c) => c.name ?? '(unnamed)');
  } catch (err) {
    logger.debug({ err, bot: bot.name }, 'extractAgent: could not list disabled components');
  }

  // The agent's AUTHORED description/displayName live in bot.configuration
  // (settings["default-2.1.0"].content). For user-authored agents this holds the
  // real description; for Microsoft prebuilt/managed agents it's empty (the
  // description is template-defined and not exposed via the Dataverse API).
  let configDescription = '';
  // Some Copilot Studio experiences/solution versions store the Overview
  // "Description" on the bot record's own `description` column (not in
  // configuration/GptComponentMetadata) — worth reading when it exists.
  // Confirmed live 2026-08-07: this column does NOT exist at all on `bot` in
  // at least one real environment (a 400 "Could not find a property named
  // 'description'", not a permissions issue) — descriptionColumnUnsupported
  // remembers that per-environment so we stop retrying a doomed query.
  let botDescription = '';
  /** Verbatim bot-record fields, accumulated across whichever fetch path this environment supports. */
  let rawBotRecord: Record<string, unknown> = {};
  let agentSettings: ReturnType<typeof parseAgentSettings> = {};
  let gotCombined = false;
  // Some Dataverse orgs/solution versions reject the combined
  // `$select=configuration,description` with a 400 even though each column is
  // selectable alone (the OData validator rejects the whole select list when
  // one field it doesn't recognize is in it). That's a schema-level property
  // of the environment, not of any one bot, so once we've seen it fail once
  // we stop retrying the combined form and stop re-warning for every
  // remaining agent in this run.
  if (!combinedSelectUnsupported.get(url)) {
    try {
      const b = await dvGet<{ configuration?: string; description?: string }>(
        url, token, `bots(${bot.botid})?$select=configuration,description`,
      );
      if (b.description) botDescription = String(b.description).trim();
      rawBotRecord = b as Record<string, unknown>;
      configDescription = parseConfigDescription(b.configuration);
      agentSettings = parseAgentSettings(b.configuration);
      gotCombined = true;
    } catch (e) {
      combinedSelectUnsupported.set(url, true);
      logger.warn(`bots($select=configuration,description) unsupported on this Dataverse environment — falling back to separate selects for the rest of this run: ${(e as Error).message}`);
    }
  }
  if (!gotCombined) {
    // Fetch configuration and description independently (in parallel) so a
    // column that isn't selectable for one doesn't also cost us the other —
    // dropping either one silently would lose an authored description
    // (classic experience lives in `configuration`, new experience in
    // `description`, where that column exists), which the lossless-extraction
    // principle doesn't allow. Skip the description fetch entirely once this
    // environment is known not to have the column — it can only 400 again.
    const descPromise: Promise<{ description?: string }> = descriptionColumnUnsupported.get(url)
      ? Promise.resolve({})
      : dvGet<{ description?: string }>(url, token, `bots(${bot.botid})?$select=description`);
    const [confResult, descResult] = await Promise.allSettled([
      dvGet<{ configuration?: string }>(url, token, `bots(${bot.botid})?$select=configuration`),
      descPromise,
    ]);
    if (confResult.status === 'fulfilled') {
      rawBotRecord = { ...rawBotRecord, ...(confResult.value as Record<string, unknown>) };
      configDescription = parseConfigDescription(confResult.value.configuration);
      agentSettings = parseAgentSettings(confResult.value.configuration);
    } else {
      logger.warn(`configuration-only fetch failed for "${bot.name}": ${(confResult.reason as Error)?.message ?? confResult.reason}`);
    }
    if (descResult.status === 'fulfilled') {
      rawBotRecord = { ...rawBotRecord, ...(descResult.value as Record<string, unknown>) };
      if (descResult.value.description) botDescription = String(descResult.value.description).trim();
    } else {
      descriptionColumnUnsupported.set(url, true);
      logger.warn(`"description" column not present on bot entity for this Dataverse environment — skipping for the rest of this run: ${(descResult.reason as Error)?.message ?? descResult.reason}`);
    }
  }

  // Hand the untouched payload to the caller before a single field is interpreted. This is
  // the only point where both halves — components and bot record — are complete and still
  // unparsed. Wrapped because a diagnostic must not be able to fail the extraction it exists
  // to explain.
  if (onRaw) {
    try {
      onRaw({
        sourceId: bot.botid,
        sourceName: bot.name,
        envUrl: url,
        components,
        botRecord: Object.keys(rawBotRecord).length ? rawBotRecord : undefined,
        disabledComponentNames,
      });
    } catch (err) {
      logger.warn({ err, bot: bot.name }, 'extractAgent: onRaw sink threw (ignored)');
    }
  }

  // Agent-level source provenance (report/audit only — NOT migrated to Gemini).
  // Best-effort: standard solution-aware columns; degrades to undefined on error.
  // `publishedon` is null for a bot that has never been published in Copilot
  // Studio (still a Draft) — the orchestrator uses this to decide whether the
  // migrated Gemini agent should be published too or left as a draft, so the
  // destination mirrors the source's publish state instead of always publishing.
  let sourceMetadata: AgentSourceMetadata | undefined;
  try {
    const b = await dvGet<Record<string, unknown>>(
      url, token,
      `bots(${bot.botid})?$select=createdon,modifiedon,ismanaged,statecode,schemaname,_ownerid_value,publishedon`,
    );
    const managed = Boolean(b.ismanaged);
    sourceMetadata = {
      type: 'Agent',
      ownerId: (b['_ownerid_value'] as string) ?? undefined,
      createdOn: (b.createdon as string) ?? undefined,
      modifiedOn: (b.modifiedon as string) ?? undefined,
      lastPublished: (b.publishedon as string) ?? undefined,
      isManaged: managed,
      protected: managed, // Copilot "Protected" ≈ part of a managed solution
      status: b.statecode === 0 ? 'active' : b.statecode === 1 ? 'inactive' : undefined,
      schemaName: (b.schemaname as string) ?? undefined,
    };
  } catch {
    /* best-effort — provenance is nice-to-have, never blocks extraction */
  }

  const permissions = await readAgentPermissions(url, token, bot.botid);

  const gptComp = components.find((c) => c.componenttype === ComponentType.CustomGpt);
  // componenttype 9 is NOT only topics. It also carries the agent's TOOLS — connector
  // operations, MCP servers, connected agents and AI Builder models — distinguished by
  // the `kind:` at the top of `data`: `AdaptiveDialog` is a topic, `TaskDialog` is a
  // tool. Treating every type-9 row as a topic meant "Jira - Get list of issues" was
  // migrated as a conversational topic (and counted as one: 22 "topics" on an agent
  // with far fewer), while the operations it actually calls were never recorded.
  const type9 = components.filter((c) => c.componenttype === ComponentType.Topic);
  const toolComps = type9.filter((c) => isAgentToolComponent(c));
  const skillComps = type9.filter((c) => isInlineSkillComponent(c));
  const topicComps = type9.filter((c) => !isAgentToolComponent(c) && !isInlineSkillComponent(c));
  const agentTools = toolComps.map(parseAgentTool);

  // Connector calls that live INSIDE a topic rather than as a standalone TaskDialog.
  // The Customer Service agents in the test tenant make every Dataverse call this way
  // (ledger 1.17): `kind: InvokeConnectorAction` as a step in an AdaptiveDialog. Reading
  // only TaskDialog rows made those agents look like they had no tools at all, while the
  // connector census correctly reported they used Dataverse — two of our own instruments
  // disagreeing, with extraction the wrong one.
  //
  // These are steps in a flow, so what survives is the CAPABILITY, not the choreography:
  // the topic decided when to call them and what to do with the result. The mapper reports
  // that; dropping them entirely would lose the capability as well.
  for (const topicComp of topicComps) {
    const payload = topicComp.data || topicComp.content || '';
    const topicName = topicComp.name ?? '(unnamed topic)';
    for (const action of parseTopicConnectorActions(payload)) {
      if (!action.operationId && !action.connectionReference) continue;
      agentTools.push({
        name: `${topicName} - ${action.operationId ?? 'connector call'}`,
        kind: 'connector',
        description:
          `Used by the "${topicName}" topic of the source agent` +
          (action.outputVariable ? `, which stored the result in ${action.outputVariable}` : '') +
          '.',
        // Topic-embedded references are solution-prefixed connection reference NAMES
        // (`QMA.Incident.DVPluginConnection`), so the middle segment is the entity, not a
        // connector. Let the operation family speak — see resolveConnectorId.
        connectorId: resolveConnectorId(action.connectionReference, action.operationId).connectorId,
        connectionAuthMode: connectionAuthModeFrom(payload),
        operationId: action.operationId,
        inputs: action.inputs.length ? action.inputs : undefined,
        sourceTopic: topicName,
        schemaName: topicComp.schemaname ?? undefined,
      });
    }
  }
  const ksComps = components.filter((c) => c.componenttype === ComponentType.KnowledgeSource);
  const fileComps = components.filter((c) => c.componenttype === ComponentType.BotFileAttachment);

  const gptParsed = gptComp
    ? parseGptMetadata(gptComp)
    : { instructions: '', description: '', capabilities: { webBrowsing: false, codeInterpreter: false }, starterPrompts: [] };
  // Newer agents carry no GptComponentMetadata at all, so their web-search setting lives
  // only on bot.configuration. Prefer whichever source actually states it; only fall back
  // to the component's default when agentSettings is silent.
  const gpt = {
    ...gptParsed,
    capabilities: {
      ...gptParsed.capabilities,
      webBrowsing: agentSettings.webSearch ?? gptParsed.capabilities.webBrowsing,
    },
  };

  // Inline skills ride alongside topics: both become sub-agents downstream, and keeping
  // them in one list means every consumer that already handles topics handles these too.
  const topics = [...topicComps.map(parseTopic), ...skillComps.map(parseInlineSkill)];
  // Knowledge = configured sources (type 16) + author-uploaded files (type 14).
  // A minority of type-14 rows are actually embedded structured configs, not
  // files (see isEmbeddedConfigSource) — route those through the
  // knowledge-source path instead of the file-fetch path.
  const knowledgeSources = [
    ...ksComps.map((c) => parseKnowledgeSource(c)),
    ...fileComps.map((c) =>
      isEmbeddedConfigSource(c) ? parseEmbeddedConfigSource(c) : parseFileAttachment(c),
    ),
  ];

  // Derive starter prompts from custom topics when the agent didn't define any.
  // Skip greetings/pleasantries and trivially short phrases — those make poor
  // conversation starters (observed: "Good afternoon", "thanks").
  let starterPrompts = gpt.starterPrompts;
  if (starterPrompts.length === 0) {
    starterPrompts = topics
      .filter((t) => !t.isSystem)
      .flatMap((t) => t.triggerPhrases)
      .filter(isUsefulStarter)
      .slice(0, 4);
  }

  const customTopics = topics.filter((t) => !t.isSystem);

  // Resolve AI Builder prompts — the real logic for prebuilt Dynamics agents.
  // The map is built once per environment and cached, so this is cheap per agent.
  const aiMap = await getAiPromptMap(url, token).catch(() => new Map<string, { name: string; prompt: string }>());
  let resolvedAiPrompts = 0;
  for (const t of topics) {
    if (!t.usesAiBuilder) continue;
    const ids = [...t.raw.matchAll(/aIModelId:\s*([a-f0-9-]{36})/gi)].map((m) => m[1]);
    for (const id of ids) {
      const hit = aiMap.get(id);
      if (!hit) continue;
      t.aiModelName = hit.name;
      if (hit.prompt) { t.aiPrompt = hit.prompt; resolvedAiPrompts++; }
      break;
    }
  }

  // Use ONLY the agent's AUTHORED description, from wherever the experience stores it:
  //   1. The CustomGpt botcomponent's own NATIVE `description` column (current
  //      Copilot Studio: this is what the Overview panel's "Description" field
  //      actually writes to — confirmed live; it's a real column on
  //      `botcomponent` even on orgs where `bot` has no `description` column
  //      at all), else
  //   2. bot.configuration.content.description (classic experience), else
  //   3. GptComponentMetadata YAML `data.description` (legacy/rare shape), else
  //   4. bot.description column (older orgs that DO expose it there), else
  //   empty. We deliberately do NOT derive a description from the instructions'
  //   first line, topics, or AI Builder prompts — if the source has no
  //   description, the destination gets none (product decision).
  const gptComponentDescription = (gptComp?.description ?? '').trim();
  const description = gptComponentDescription || configDescription || gpt.description || botDescription || '';

  // "Thin" = nothing meaningful to carry over: no instructions, no readable
  // topic content, AND no resolvable AI Builder prompt.
  const hasReadableTopicContent = customTopics.some(
    (t) => t.modelDescription || stripBindings(t.summary),
  );
  const hasAiPrompt = topics.some((t) => t.aiPrompt);
  // TOOLS are authored content. "Hubspot agentt" is four HubSpot connector calls and
  // nothing else, and reported thin — the report told the customer there was nothing to
  // migrate about an agent whose entire purpose is those four calls. Thin must mean the
  // agent does nothing, not that it does nothing we happened to look at.
  const thinContent =
    !gpt.instructions && !hasReadableTopicContent && !hasAiPrompt && agentTools.length === 0;

  const unmapped: string[] = [];

  // Agent-level settings we read but do not reproduce. Naming them is the whole point of
  // `unmapped` — the report says what we left behind rather than pretending it was not
  // there. Memory in particular is a live customer setting (the author switched it on in
  // the Build pane) and the memory migration cannot warn about memory it never saw.
  if (agentSettings.memoryEnabled) {
    unmapped.push('agentSettings.enableMemory=true (Copilot memory is ON for this agent)');
  }
  if (agentSettings.modelSeries) {
    unmapped.push(`agentSettings.model.series=${agentSettings.modelSeries} (source model choice; Gemini uses its own)`);
  }

  // Evaluation data (componenttype 19) — the agent's authored TEST questions and
  // evaluation sets. Not runtime behaviour, so nothing is functionally lost by not
  // migrating them, but they ARE authored content: 11 of this agent's 38 components
  // were evaluation rows that disappeared without a word. "Lossless" means the report
  // says what we left behind, not that we migrate everything.
  const evalComps = components.filter((c) => c.componenttype === 19);
  if (evalComps.length) {
    unmapped.push(
      `${evalComps.length} evaluation component(s) (test questions / evaluation sets authored in ` +
        `Copilot Studio) were read but not migrated — Gemini has no equivalent. They remain in the ` +
        `source agent.`,
    );
  }

  // Components the author DISABLED in Copilot Studio. Extraction filters `statecode eq 0`,
  // so these never reach the IR — correct, but worth stating: an admin comparing tool
  // counts between the two platforms should know one was switched off, not missing.
  if (disabledComponentNames.length) {
    unmapped.push(
      `${disabledComponentNames.length} component(s) are disabled in the source agent and were not ` +
        `migrated: ${disabledComponentNames.join(', ')}.`,
    );
  }

  if (knowledgeSources.length) {
    const fileCount = knowledgeSources.filter((k) => k.kind === 'FileUpload').length;
    const nonFile = knowledgeSources.filter((k) => k.kind !== 'FileUpload');
    const nonFileDetail = nonFile.length
      ? ` Non-file sources are classified with a recommendation but NOT auto-created this run: ${nonFile.map((k) => `${k.name}→${k.classification?.strategy}`).join(', ')}.`
      : '';
    // This note describes the PLAN at extraction time, before the insert phase
    // has run — it is not a claim that the upload succeeded. The actual
    // per-file outcome (including any failure reason) is reported separately,
    // as a `knowledge:<filename>` fidelity entry, once insert actually runs.
    unmapped.push(
      `${knowledgeSources.length} knowledge source(s): ${fileCount} uploaded file(s) will be uploaded and attached automatically during the insert phase (see the "knowledge:<filename>" entries below for the actual per-file result).` +
        nonFileDetail,
    );
  }
  const withAi = topics.filter((t) => t.usesAiBuilder).length;
  if (withAi && resolvedAiPrompts) {
    unmapped.push(`${resolvedAiPrompts}/${withAi} AI Builder model prompt(s) recovered and folded into the instruction${resolvedAiPrompts < withAi ? `; ${withAi - resolvedAiPrompts} unresolved (nested file refs)` : ''}`);
  } else if (withAi) {
    unmapped.push(`${withAi} topic(s) invoke AI Builder models — prompts not resolvable (nested file refs); behavior approximated by Gemini reasoning`);
  }
  const withCards = topics.filter((t) => t.usesAdaptiveCards).length;
  if (withCards) unmapped.push(`${withCards} topic(s) emit Adaptive Cards — rendered as markdown`);
  if (thinContent) {
    unmapped.push(
      'No authored instructions or readable topic content found — likely a Microsoft prebuilt/AI-Builder agent whose behavior is template-defined and not stored in Dataverse. Needs manual authoring in Gemini.',
    );
  }

  logger.info(
    {
      bot: bot.name,
      instructionChars: gpt.instructions.length,
      descriptionChars: description.length,
      topics: topics.length,
      customTopics: customTopics.length,
      aiPromptsResolved: resolvedAiPrompts,
      ks: knowledgeSources.length,
      thinContent,
    },
    'extracted agent',
  );

  return {
    sourceId: bot.botid,
    name: bot.name,
    instructions: gpt.instructions,
    description,
    capabilities: gpt.capabilities,
    starterPrompts,
    topics,
    knowledgeSources,
    thinContent,
    unmapped,
    sourceMetadata,
    permissions,
    agentTools: agentTools.length ? agentTools : undefined,
  };
}

/** Lightweight counts for the review screen (agents / topics / KS / flows). */
export async function inventory(url: string, token: string): Promise<{
  bots: number;
  topics: number;
  knowledgeSources: number;
  flows: number;
}> {
  const [bots, comps, flows] = await Promise.all([
    dvGet<{ value: unknown[] }>(url, token, 'bots?$select=botid&$filter=statecode eq 0'),
    dvGet<{ value: { componenttype: number }[] }>(
      url,
      token,
      'botcomponents?$select=componenttype&$filter=statecode eq 0',
    ),
    dvGet<{ value: unknown[] }>(url, token, 'workflows?$select=workflowid&$filter=category eq 5').catch(
      () => ({ value: [] as unknown[] }),
    ),
  ]);
  let topics = 0;
  let knowledgeSources = 0;
  for (const c of comps.value ?? []) {
    if (c.componenttype === ComponentType.Topic) topics++;
    else if (c.componenttype === ComponentType.KnowledgeSource || c.componenttype === ComponentType.BotFileAttachment) {
      knowledgeSources++;
    }
  }
  return {
    bots: bots.value?.length ?? 0,
    topics,
    knowledgeSources,
    flows: flows.value?.length ?? 0,
  };
}
