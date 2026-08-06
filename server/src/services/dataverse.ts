import { parse as parseYaml } from 'yaml';
import { logger } from '../logger.js';
import { ComponentType } from '../types.js';
import { parseTopicGraph } from './topicGraph.js';
import { classifyKnowledgeSource, checkFileCompatibility } from './knowledgeClassifier.js';
import type { AgentIR, AgentPermissions, AgentSourceMetadata, ChatAccess, KnowledgeSourceIR, KnowledgeSourceMetadata, PrincipalRef, SharedPrincipal, TopicIR } from '../types.js';

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
      if (/\(403\)|\(401\)/i.test(msg) || /insufficient|privilege|access/i.test(msg)) {
        readError = 'shares not readable (insufficient app-user privilege)';
      } else {
        readError = `shares not readable: ${msg.slice(0, 200)}`;
      }
      sharedPrincipals = [];
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

/** Follow @odata.nextLink pages, collecting all rows. */
async function dvGetAll<T>(url: string, token: string, path: string): Promise<T[]> {
  const rows: T[] = [];
  let next: string | null = API(url, path);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=500' };
  while (next) {
    const res = await fetch(next, { headers });
    if (!res.ok) throw new Error(`Dataverse GET failed (${res.status})`);
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
function parseConfigDescription(configuration?: string): string {
  const cfg = configuration ? (JSON.parse(configuration) as Record<string, unknown>) : null;
  const settings = (cfg?.settings ?? {}) as Record<string, { content?: { description?: string } }>;
  const content = settings['default-2.1.0']?.content
    ?? Object.values(settings).find((s) => s?.content?.description)?.content;
  return content?.description ? String(content.description).trim() : '';
}

/**
 * Extract one agent into a complete AgentIR. Pulls all components for the bot
 * in a single query, then partitions by type.
 */
export async function extractAgent(
  url: string,
  token: string,
  bot: BotSummary,
): Promise<AgentIR> {
  const json = await dvGet<{ value: BotComponent[] }>(
    url,
    token,
    'botcomponents?$select=name,data,content,componenttype,_parentbotid_value,filedata_name,createdon,modifiedon,ismanaged,statuscode,description,_modifiedby_value,schemaname' +
      `&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid}&$top=1000`,
  );
  const components = json.value ?? [];

  // The agent's AUTHORED description/displayName live in bot.configuration
  // (settings["default-2.1.0"].content). For user-authored agents this holds the
  // real description; for Microsoft prebuilt/managed agents it's empty (the
  // description is template-defined and not exposed via the Dataverse API).
  let configDescription = '';
  // The NEW Copilot Studio experience stores the Overview "Description" on the
  // bot record's own `description` column (not in configuration/GptComponentMetadata),
  // so we read it too — otherwise authored descriptions from new-experience agents
  // are silently dropped.
  let botDescription = '';
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
      configDescription = parseConfigDescription(b.configuration);
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
    // `description`), which the lossless-extraction principle doesn't allow.
    const [confResult, descResult] = await Promise.allSettled([
      dvGet<{ configuration?: string }>(url, token, `bots(${bot.botid})?$select=configuration`),
      dvGet<{ description?: string }>(url, token, `bots(${bot.botid})?$select=description`),
    ]);
    if (confResult.status === 'fulfilled') {
      configDescription = parseConfigDescription(confResult.value.configuration);
    } else {
      logger.warn(`configuration-only fetch failed for "${bot.name}": ${(confResult.reason as Error)?.message ?? confResult.reason}`);
    }
    if (descResult.status === 'fulfilled') {
      if (descResult.value.description) botDescription = String(descResult.value.description).trim();
    } else {
      logger.warn(`description-only fetch failed for "${bot.name}": ${(descResult.reason as Error)?.message ?? descResult.reason}`);
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
  const topicComps = components.filter((c) => c.componenttype === ComponentType.Topic);
  const ksComps = components.filter((c) => c.componenttype === ComponentType.KnowledgeSource);
  const fileComps = components.filter((c) => c.componenttype === ComponentType.BotFileAttachment);

  const gpt = gptComp
    ? parseGptMetadata(gptComp)
    : { instructions: '', description: '', capabilities: { webBrowsing: false, codeInterpreter: false }, starterPrompts: [] };

  const topics = topicComps.map(parseTopic);
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
  const thinContent = !gpt.instructions && !hasReadableTopicContent && !hasAiPrompt;

  const unmapped: string[] = [];
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
