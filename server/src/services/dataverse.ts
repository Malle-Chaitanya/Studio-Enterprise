import { parse as parseYaml } from 'yaml';
import { logger } from '../logger.js';
import { ComponentType } from '../types.js';
import { parseTopicGraph } from './topicGraph.js';
import { classifyKnowledgeSource, checkFileCompatibility } from './knowledgeClassifier.js';
import type { AgentIR, AgentSourceMetadata, KnowledgeSourceIR, KnowledgeSourceMetadata, TopicIR } from '../types.js';

/**
 * Copilot Studio extraction: reads an agent's complete definition from the
 * Dataverse Web API and builds a normalized AgentIR.
 *
 * Fidelity focus (vs. the POC): we read the REAL agent instructions from the
 * GptComponentMetadata component, parse every topic's AdaptiveDialog YAML, and
 * capture knowledge sources — instead of regex-scraping a handful of topics.
 */

const API = (url: string, path: string) => `${url}/api/data/v9.2/${path}`;

interface BotComponent {
  botcomponentid: string;
  name: string;
  data: string | null;
  componenttype: number;
  _parentbotid_value?: string;
  /** File name for Bot File Attachment (type 14) components. */
  filedata_name?: string | null;
  // ── provenance metadata (audit trail) ──
  createdon?: string | null;
  modifiedon?: string | null;
  ismanaged?: boolean | null;
  statuscode?: number | null;
}

/** Build the provenance metadata block for a knowledge component. */
function buildKnowledgeMetadata(c: BotComponent): KnowledgeSourceMetadata {
  return {
    componentType: c.componenttype,
    createdOn: c.createdon ?? undefined,
    modifiedOn: c.modifiedon ?? undefined,
    isManaged: c.ismanaged ?? undefined,
    status: c.statuscode == null ? undefined : c.statuscode === 1 ? 'active' : 'inactive',
  };
}

async function dvGet<T>(url: string, token: string, path: string): Promise<T> {
  const res = await fetch(API(url, path), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Dataverse GET ${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface BotSummary {
  botid: string;
  name: string;
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

/** List all active agents (bots) in the environment. */
export async function listBots(url: string, token: string): Promise<BotSummary[]> {
  const json = await dvGet<{ value: BotSummary[] }>(
    url,
    token,
    'bots?$select=name,botid&$filter=statecode eq 0',
  );
  return json.value ?? [];
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

function parseKnowledgeSource(c: BotComponent, ownerDomains?: string[]): KnowledgeSourceIR {
  const doc = tryParseYaml(c.data);
  const kind = (doc?.kind as string) ?? (doc?.knowledgeSourceType as string) ?? 'Unknown';

  // All references (URLs, site paths, entity names) — not just the first.
  const refs: string[] = [];
  if (doc) collectStrings(doc, (k) => /url|site|siteurl|reference|entity|path|connection/i.test(k), refs);
  const references = dedupe(refs);

  // Author's description of what this source is for ("...answer questions about
  // the Dynamics 365 contact center product") — folded into the Gemini agent's
  // instruction for website sources that can't become a data store.
  const descRaw = (doc?.description as string) ?? '';
  const description = descRaw.trim() ? descRaw.trim().slice(0, 500) : undefined;

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
    if (fileName || sizeBytes) file = { name: fileName, sizeBytes };
  }

  const classification = classifyKnowledgeSource({ kind, references, file, ownerDomains });

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

  return {
    id: c.botcomponentid,
    name: c.name,
    kind,
    reference: references[0],
    references,
    description,
    file,
    classification,
    metadata: buildKnowledgeMetadata(c),
    raw: doc ?? c.data ?? undefined,
  };
}

/**
 * Parse a Bot File Attachment (componenttype 14) — an author-uploaded knowledge
 * file. The bytes live in the `filedata` File column (fetched separately at
 * migration time via …/filedata/$value); here we capture the name so the
 * classifier can apply Gemini's format/size ingest gate.
 */
function parseFileAttachment(c: BotComponent): KnowledgeSourceIR {
  const fileName = (c.filedata_name || c.name || 'file').trim();
  const compat = checkFileCompatibility(fileName);
  const file = { name: fileName, format: compat.format, compatible: compat.compatible, incompatReason: compat.reason };
  const classification = classifyKnowledgeSource({ kind: 'FileUpload', file: { name: fileName } });
  return { id: c.botcomponentid, name: fileName, kind: 'FileUpload', file, classification, metadata: buildKnowledgeMetadata(c) };
}

/**
 * Extract one agent into a complete AgentIR. Pulls all components for the bot
 * in a single query, then partitions by type.
 */
export async function extractAgent(
  url: string,
  token: string,
  bot: BotSummary,
  opts?: { ownerDomains?: string[] },
): Promise<AgentIR> {
  const json = await dvGet<{ value: BotComponent[] }>(
    url,
    token,
    'botcomponents?$select=name,data,componenttype,_parentbotid_value,filedata_name,createdon,modifiedon,ismanaged,statuscode' +
      `&$filter=statecode eq 0 and _parentbotid_value eq ${bot.botid}&$top=1000`,
  );
  const components = json.value ?? [];

  // The agent's AUTHORED description/displayName live in bot.configuration
  // (settings["default-2.1.0"].content). For user-authored agents this holds the
  // real description; for Microsoft prebuilt/managed agents it's empty (the
  // description is template-defined and not exposed via the Dataverse API).
  let configDescription = '';
  try {
    const b = await dvGet<{ configuration?: string }>(url, token, `bots(${bot.botid})?$select=configuration`);
    const cfg = b.configuration ? (JSON.parse(b.configuration) as Record<string, unknown>) : null;
    const settings = (cfg?.settings ?? {}) as Record<string, { content?: { description?: string } }>;
    const content = settings['default-2.1.0']?.content;
    if (content?.description) configDescription = String(content.description).trim();
  } catch {
    /* non-fatal — fall back to instruction-derived description */
  }

  // Agent-level source provenance (report/audit only — NOT migrated to Gemini).
  // Best-effort: standard solution-aware columns; degrades to undefined on error.
  let sourceMetadata: AgentSourceMetadata | undefined;
  try {
    const b = await dvGet<Record<string, unknown>>(
      url, token,
      `bots(${bot.botid})?$select=createdon,modifiedon,ismanaged,statecode,schemaname,_ownerid_value`,
    );
    const managed = Boolean(b.ismanaged);
    sourceMetadata = {
      type: 'Agent',
      ownerId: (b['_ownerid_value'] as string) ?? undefined,
      createdOn: (b.createdon as string) ?? undefined,
      modifiedOn: (b.modifiedon as string) ?? undefined,
      isManaged: managed,
      protected: managed, // Copilot "Protected" ≈ part of a managed solution
      status: b.statecode === 0 ? 'active' : b.statecode === 1 ? 'inactive' : undefined,
      schemaName: (b.schemaname as string) ?? undefined,
    };
  } catch {
    /* best-effort — provenance is nice-to-have, never blocks extraction */
  }

  const gptComp = components.find((c) => c.componenttype === ComponentType.CustomGpt);
  const topicComps = components.filter((c) => c.componenttype === ComponentType.Topic);
  const ksComps = components.filter((c) => c.componenttype === ComponentType.KnowledgeSource);
  const fileComps = components.filter((c) => c.componenttype === ComponentType.BotFileAttachment);

  const gpt = gptComp
    ? parseGptMetadata(gptComp)
    : { instructions: '', description: '', capabilities: { webBrowsing: false, codeInterpreter: false }, starterPrompts: [] };

  const topics = topicComps.map(parseTopic);
  // Knowledge = configured sources (type 16) + author-uploaded files (type 14).
  const knowledgeSources = [
    ...ksComps.map((c) => parseKnowledgeSource(c, opts?.ownerDomains)),
    ...fileComps.map(parseFileAttachment),
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

  // Use ONLY the agent's AUTHORED description:
  //   1. bot.configuration.content.description (author-written), else
  //   2. GptComponentMetadata.description, else
  //   empty. We deliberately do NOT derive a description from the instructions'
  //   first line, topics, or AI Builder prompts — if the source has no
  //   description, the destination gets none (product decision).
  const description = configDescription || gpt.description || '';

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
    // Accurate wording: uploaded FILES migrate to the agent (agentFiles);
    // data-store sources (websites/Dataverse) are recommended, not yet executed.
    unmapped.push(
      `${knowledgeSources.length} knowledge source(s): ${fileCount} uploaded file(s) migrate to the agent's Knowledge automatically.` +
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
