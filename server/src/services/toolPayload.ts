/**
 * Read everything a Copilot TaskDialog payload says about a tool.
 *
 * WHY A SEPARATE MODULE. Extraction previously took the tool's identity (connector,
 * operation, description) and stopped. But the payload also carries what the author BOUND:
 * fixed argument values, which arguments the model fills, the typed result shape, an MCP
 * server's allowed tool list, a flow id, a plugin identity. Proven present in live payloads
 * (docs/verification-ledger.md §1.12) — this was an extraction gap, not an access problem.
 *
 * Without the bindings we can only rebuild a tool of the same SHAPE and let the model
 * invent arguments. With them we can rebuild the call the author actually configured.
 *
 * PARSED WITH TARGETED SCANNING, NOT A YAML LOAD, for the same reason `parseTopic` does:
 * these bodies are Copilot's own dialect and vary between product versions and tenants. A
 * strict parse throws on the first unseen shape and drops the whole tool; a scanner degrades
 * field by field. This is a multi-tenant product — every customer's payloads will differ in
 * ways this tenant's do not, so nothing here may assume a field exists, and anything
 * unrecognised is preserved rather than dropped.
 *
 * Pure: no I/O, no config. Kept out of `dataverse.ts` because that module pulls in the
 * fail-fast config, which makes its functions unreachable from unit tests.
 */

/** One argument the source agent supplies to its tool. */
export interface ToolInputIR {
  /** Property name as the connector names it, unquoted (`$filter`, `entityName`). */
  name: string;
  /**
   * `fixed`   — the author pinned a value (`ManualTaskInput`). Migrating it preserves the
   *             call; leaving it to the model changes what the agent does.
   * `model`   — the author left it for the model to fill (`AutomaticTaskInput`), so it
   *             belongs in the migrated tool's signature.
   * `unknown` — an input kind we have not seen. Preserved so the report can name it.
   */
  source: 'fixed' | 'model' | 'unknown';
  /** The pinned value, verbatim, for `fixed` inputs. */
  value?: string;
  /**
   * True when `value` is a Power Fx expression (Copilot writes these with a leading `=`),
   * e.g. `=Concatenate("… eq '", Global.SelectedPhoneNumber, "'")`.
   *
   * These CANNOT be copied through as literals — the target would send the word
   * `Concatenate` to the vendor. They reference runtime state that does not exist on the
   * Gemini side, so they must either be evaluated by a Power Fx subset or demoted to a
   * model-supplied argument with a `needs-review` note. Flagged here so no caller can treat
   * one as a literal by accident.
   */
  isExpression?: boolean;
  /** Author's description of the input, when present. */
  description?: string;
  /** Declared entity/type for a model-filled input, e.g. `StringPrebuiltEntity`. */
  entity?: string;
  /** The raw `kind:` line, when it was not one we recognise. */
  rawKind?: string;
}

/** One field of the tool's declared result shape (`dynamicOutputSchema`). */
export interface ToolOutputFieldIR {
  name: string;
  /** Copilot's own type word (`String`, `Number`, `Table`, `Record`, …). */
  type: string;
  /** Dotted path for nested fields, e.g. `value.msdyn_stage`. */
  path?: string;
}

/** An MCP server exposed as a tool, with the tools the author allowed. */
export interface McpBindingIR {
  operationId?: string;
  /**
   * `specific` — the author allow-listed named tools (`UseSpecificTools`). Migrating the
   *              server without the list would grant the agent MORE than it had.
   * `all`      — every tool the server exposes.
   * `unknown`  — the payload did not say; treat as `specific` with an empty list rather
   *              than assuming `all`.
   */
  toolSelection: 'specific' | 'all' | 'unknown';
  tools?: string[];
}

const KNOWN_INPUT_KINDS: Record<string, ToolInputIR['source']> = {
  manualtaskinput: 'fixed',
  automatictaskinput: 'model',
};

/** `"'$filter'"` → `$filter`; leaves ordinary names untouched. */
function unquoteName(raw: string): string {
  return raw.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1').trim();
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Lines belonging to a top-level block, e.g. everything under `inputs:`.
 *
 * Returns the block's lines with their original indentation. An absent block returns an
 * empty array — never throws, because a tool without inputs is normal, not an error.
 */
function blockLines(data: string, key: string): string[] {
  const lines = data.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*${key}:\\s*$`).test(l));
  if (start === -1) return [];
  const baseIndent = indentOf(lines[start]);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    if (indentOf(line) <= baseIndent) break;
    out.push(line);
  }
  return out;
}

/** Read `key: value` from a set of lines, ignoring deeper nesting. */
function scalar(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const m = new RegExp(`^\\s*${key}:\\s*(.+)$`).exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

/**
 * The arguments the source agent binds to its tool.
 *
 * Entries look like:
 *   - kind: ManualTaskInput
 *     propertyName: entityName
 *     value: msdyn_transformationjobs
 * or, for a model-filled one, `kind: AutomaticTaskInput` with an `entity:`.
 */
export function parseToolInputs(data: string): ToolInputIR[] {
  const lines = blockLines(data, 'inputs');
  if (!lines.length) return [];

  // Split on the `- ` item markers at the shallowest indentation in the block.
  const itemIndents = lines.filter((l) => /^\s*-\s/.test(l)).map(indentOf);
  if (!itemIndents.length) return [];
  const itemIndent = Math.min(...itemIndents);

  const items: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^\s*-\s/.test(line) && indentOf(line) === itemIndent) {
      if (current) items.push(current);
      // Normalise `- kind: X` to `kind: X` so the item reads like a plain mapping.
      current = [line.replace(/^(\s*)-\s/, '$1  ')];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) items.push(current);

  const out: ToolInputIR[] = [];
  for (const item of items) {
    const rawKind = scalar(item, 'kind') ?? '';
    const name = scalar(item, 'propertyName');
    if (!name) continue; // an input with no property name binds nothing
    const source = KNOWN_INPUT_KINDS[rawKind.toLowerCase()] ?? 'unknown';
    const value = scalar(item, 'value');
    out.push({
      name: unquoteName(name),
      source,
      value: value ?? undefined,
      // Copilot marks Power Fx with a leading `=`. Anything else is a literal.
      isExpression: value?.startsWith('=') || undefined,
      description: scalar(item, 'description'),
      entity: scalar(item, 'entity'),
      rawKind: source === 'unknown' && rawKind ? rawKind : undefined,
    });
  }
  return out;
}

/**
 * The tool's declared result shape, flattened to `path` + `type`.
 *
 * Copilot nests this arbitrarily (`value` → `Table` → per-column types). Flattening keeps
 * the IR readable while preserving every field name, which is what a migrated tool needs in
 * order to describe its output to the model.
 */
export function parseOutputSchema(data: string): ToolOutputFieldIR[] {
  const lines = blockLines(data, 'dynamicOutputSchema');
  if (!lines.length) return [];
  const out: ToolOutputFieldIR[] = [];
  // Track the property-name stack by indentation so nested columns keep their parent path.
  const stack: Array<{ indent: number; name: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)([A-Za-z_$][\w$.-]*):\s*$/.exec(line);
    if (m) {
      const indent = m[1].length;
      const name = m[2];
      // `properties` / `type` are structural, not field names.
      if (name === 'properties' || name === 'type') continue;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, name });
      continue;
    }
    const t = /^\s*(?:type|kind):\s*([A-Za-z]+)\s*$/.exec(line);
    if (t && stack.length) {
      const path = stack.map((s) => s.name).join('.');
      const name = stack[stack.length - 1].name;
      // A field can carry both `type:` and a nested `kind:`; keep the first statement.
      if (!out.some((f) => f.path === path)) out.push({ name, type: t[1], path });
    }
  }
  return out;
}

/**
 * An MCP server tool and the tools the author allowed.
 *
 * The allow-list is load-bearing for fidelity in the strict direction: migrating the server
 * without it hands the agent every tool the server exposes, which is MORE access than the
 * source agent had. An absent list is therefore reported as `unknown`, never widened to
 * `all`.
 */
export function parseMcpBinding(data: string): McpBindingIR | undefined {
  if (!/kind:\s*ModelContextProtocolMetadata/i.test(data) && !/InvokeExternalAgentTaskAction/i.test(data)) {
    return undefined;
  }
  const operationId = /^\s*operationId:\s*(\S+)\s*$/m.exec(data)?.[1];
  const selectionWord = /kind:\s*Use(SpecificTools|AllTools)/i.exec(data)?.[1];
  const toolSelection: McpBindingIR['toolSelection'] =
    selectionWord?.toLowerCase() === 'specifictools'
      ? 'specific'
      : selectionWord?.toLowerCase() === 'alltools'
        ? 'all'
        : 'unknown';
  // The list sits under the second `tools:` key (the first introduces the selection).
  const toolLines = data.split(/\r?\n/);
  const tools: string[] = [];
  let inList = false;
  let listIndent = -1;
  for (const line of toolLines) {
    if (/^\s*tools:\s*$/.test(line)) {
      // Start collecting at the deepest `tools:` we meet; a nested one replaces the outer.
      inList = true;
      listIndent = indentOf(line);
      continue;
    }
    if (!inList) continue;
    const item = /^(\s*)-\s+(\S.*)$/.exec(line);
    if (item && item[1].length > listIndent) {
      tools.push(item[2].trim());
      continue;
    }
    if (line.trim() && indentOf(line) <= listIndent) inList = false;
  }
  return { operationId, toolSelection, tools: tools.length ? tools : undefined };
}

/**
 * The Power Automate flow a tool invokes.
 *
 * Only the id is in the payload — the flow's own logic lives in `workflows` and is Phase 2.
 * Extracting the id is still worth it: it is the difference between "this agent calls a
 * flow we did not migrate" and "this agent had a tool we cannot name".
 */
export function parseFlowId(data: string): string | undefined {
  return /^\s*flowId:\s*(\S+)\s*$/m.exec(data)?.[1];
}

/**
 * The AI plugin (custom API added in Copilot Studio) a tool invokes.
 *
 * Identity comes from `entityKey`, e.g.
 * `aiplugin.name=aiplugin_UpdateKBArticle,operationid=aiplugin_UpdateKBArticle`.
 */
export function parseAiPluginRef(data: string): { name?: string; operationId?: string } | undefined {
  const key = /^\s*entityKey:\s*(.+)$/m.exec(data)?.[1]?.trim();
  if (!key || !/aiplugin/i.test(key)) return undefined;
  return {
    name: /name=([^,\s]+)/.exec(key)?.[1],
    operationId: /operationid=([^,\s]+)/i.exec(key)?.[1],
  };
}
