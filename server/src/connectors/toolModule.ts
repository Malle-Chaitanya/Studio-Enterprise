import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Does this connector kind have a hand-written Python tool module, or does it fall through to
 * the generic REST builder?
 *
 * The distinction decides whether `boundOperations` survive the deploy, and getting it wrong
 * makes the pipeline lie. `adk_deploy.py` dispatches on `kind`: a dedicated
 * `connector_tools/<kind>.py` returns ITS OWN hand-written tools and never looks at
 * `boundOperations`, while the `generic_rest.py` fallback builds one typed tool per bound
 * operation. So for a dedicated module the bound specs are silently dropped.
 *
 * Measured 2026-08-20 on the customer's "Teams Coordinator": the orchestrator logged
 * "4 connector operation(s) rebuilt as exact API calls", handed those four names to
 * verification, and the deployed agent had none of them — because `teams.py` exists and
 * returned its own nine read tools instead. The migration was fine; the CLAIM was false, and
 * it failed verification for the wrong reason.
 *
 * Derived from the filesystem rather than a hardcoded list, deliberately: the Python dispatch
 * IS the source of truth, and a list here would drift the first time someone adds a module.
 * A new `connector_tools/<kind>.py` is picked up with no change to this file.
 */

/** Where the Python connector modules live, relative to the server package root. */
const TOOL_MODULE_DIR = 'scripts/connector_tools';

/**
 * Kinds that share one module. `adk_deploy.py` maps several kinds onto a single file
 * (SharePoint and OneDrive are both `sharepoint.py`, `chat` and `googlechat` both `chat.py`),
 * so a plain `<kind>.py` existence check would miss them and wrongly promise bound tools.
 * Mirrors the dispatch block in adk_deploy.py — the one place that cannot be derived, so it
 * is asserted by a test against the Python source instead.
 */
const KIND_ALIASES: Record<string, string> = {
  sharepointonline: 'sharepoint',
  sharepoint: 'sharepoint',
  onedrive: 'sharepoint',
  googlechat: 'chat',
  chat: 'chat',
  // The file name is not always the kind: `googledrive` is served by google_drive.py. A
  // <kind>.py check missed it, and the drift test caught it immediately — which is the
  // reason that test reads the Python instead of trusting this table.
  googledrive: 'google_drive',
};

/**
 * Kinds matched by PREFIX rather than exact name, mirroring `if kind.startswith(...)` in the
 * Python dispatch.
 *
 * HubSpot is shipped by Power Platform as four separate connectors — the Microsoft one plus
 * three Independent Publisher variants (`hubspotcrm`, `hubspotcrmv2`, `hubspotsettingsv2`) —
 * and agents in the field use the Independent Publisher names. They are one REST API behind
 * one private app token, so one module serves all four. An exact-match table would have to
 * name every variant and would silently miss the next one HubSpot publishes.
 */
const KIND_PREFIXES: Array<[string, string]> = [['hubspot', 'hubspot']];

/** Cached per process — this is a filesystem stat on a hot path. */
const cache = new Map<string, boolean>();

/**
 * True when `kind` resolves to a hand-written module, meaning bound operations will NOT be
 * deployed for it and must not be claimed.
 */
export function hasDedicatedToolModule(kind: string, scriptsRoot?: string): boolean {
  const normalised = (kind || '').toLowerCase().replace(/^shared_/, '');
  const file =
    KIND_ALIASES[normalised] ??
    KIND_PREFIXES.find(([prefix]) => normalised.startsWith(prefix))?.[1] ??
    normalised;
  const key = `${scriptsRoot ?? ''}:${file}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const path = resolve(scriptsRoot ?? process.cwd(), TOOL_MODULE_DIR, `${file}.py`);
  const found = !!file && existsSync(path);
  cache.set(key, found);
  return found;
}

/**
 * Of these connectors, which will actually receive their bound operations?
 *
 * Use this before claiming bound operations in a log line, a fidelity note, or the list handed
 * to verification. A connector with a dedicated module still gets that module's own tools —
 * it is not broken, and its capability is reported through the equivalence table instead.
 */
export function connectorsHonouringBoundOperations<T extends { id?: string; kind?: string }>(
  connectors: T[],
): T[] {
  return connectors.filter((c) => !hasDedicatedToolModule(c.kind ?? c.id ?? ''));
}
