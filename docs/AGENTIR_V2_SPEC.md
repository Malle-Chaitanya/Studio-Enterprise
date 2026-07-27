# CloudFuze AgentIR v2 — Specification

**Status:** contract for the Copilot Studio → Gemini Enterprise migration tool.
**Audience:** anyone writing a parser (source → IR), a mapper (IR → target), an
assessor, or a validator. All of them build against *this*, not against Copilot
or Gemini directly.

`schemaVersion: 2`

---

## 1. Principles (non-negotiable)

1. **Lossless extraction.** The parser captures everything the source expresses,
   even if today's target can't use it. If structure is discarded at extraction,
   every future mapper is capped forever.
2. **Model behavior, not a summary.** A topic is a graph of nodes (question →
   condition → action → message), never a prose description. The IR is executable
   intent, not documentation.
3. **Target-independent.** No Gemini-specific (or Copilot-specific) concept leaks
   into the IR. Loss happens only in the mapper, and it must be reported.
4. **Loss is a transform decision, made visibly.** When a target can't represent
   something, the mapper records a fidelity note; extraction never silently drops.
5. **Separate behavior / presentation / metadata.** Adaptive Cards are UI, not
   logic. Author/version/IDs are metadata, not behavior. Keep them apart.

Mental model: this is a **compiler**. Copilot → parser → AgentIR (the AST) →
mapper (code generator) → target. New source = new parser; new target = new
mapper; assessment/validation/reporting all operate on the AST.

---

## 2. Versioning

- Every IR document carries `schemaVersion` (integer). This spec is `2`.
- Changes are **additive**: add optional fields; never repurpose or delete a
  field's meaning. A breaking change bumps the integer.
- Parsers stamp the version they produced; mappers/validators read it and may
  refuse an unknown major version. No schema-migration tooling is built until a
  real break forces it (deferred, not designed now).

---

## 3. Object model

```ts
interface AgentIR {
  schemaVersion: 2;

  // ── metadata (never migrated; reported / used for traceability) ──
  metadata: {
    sourceId: string;           // Copilot botid
    sourcePlatform: 'copilot-studio';
    environment: { id: string; name: string; url: string };
    extractedAt: string;        // ISO; stamped after extraction, not in-graph
    author?: string;
    locale?: string;
  };

  // ── identity / display ──
  name: string;
  description: string;

  // ── runtime config ──
  model: { source: string };   // e.g. "Claude Sonnet", "GPT-4.1" — mapper maps/warns
  capabilities: { webBrowsing: boolean; codeInterpreter: boolean };
  instructions: string;         // the real GptComponentMetadata prompt (verbatim)
  starterPrompts: string[];

  // ── behavior ──
  variables: VariableIR[];
  entities: EntityIR[];
  topics: TopicIR[];            // each is a graph (§4)

  // ── knowledge & actions ──
  knowledge: KnowledgeIR[];
  tools: ToolIR[];

  // ── cross-references (§6) ──
  dependencies: DependencyIR[];

  // ── reported, not migrated ──
  channels: string[];
  auth?: { kind: string; detail?: string };
}
```

```ts
interface VariableIR { name: string; scope: 'global' | 'topic'; type: string; }
interface EntityIR   { name: string; kind: 'prebuilt' | 'closed-list' | 'regex'; values?: string[]; }
interface KnowledgeIR{ id: string; name: string; kind: string; reference?: string; } // reference = the source to re-ingest
interface ToolIR     { id: string; name: string; kind: 'connector' | 'http' | 'flow' | 'ai-builder'; schema?: { inputs?: unknown; outputs?: unknown }; }
```

---

## 4. Topic graph (the heart)

A topic is a directed graph. Loss at extraction here is the difference between a
migrator and a summarizer.

```ts
interface TopicIR {
  id: string;
  name: string;
  isSystem: boolean;                    // Fallback/Escalate/Greeting/etc.
  trigger: { phrases: string[]; type: 'intent' | 'event' | 'activity' };
  rootNodeId: string;
  nodes: DialogNode[];
  presentation: PresentationAsset[];    // §5 — cards referenced by node, stored here
}

type DialogNode =
  | { id: string; kind: 'message';   textRef?: string; presentationId?: string; next?: string }
  | { id: string; kind: 'question';  prompt: string; storeIn: string; entity?: string; validation?: string; retries?: number; next?: string }
  | { id: string; kind: 'condition'; branches: { expr: string; then: string }[]; else?: string }
  | { id: string; kind: 'loop';      overVar: string; itemVar: string; body: string; next?: string }
  | { id: string; kind: 'setVar';    target: string; expr: string; next?: string }
  | { id: string; kind: 'action';    dependencyId: string; inputs: Record<string,string>; outputs: Record<string,string>; next?: string }
  | { id: string; kind: 'goto';      target: string }
  | { id: string; kind: 'end' | 'escalate' | 'transfer' };
```

- Node kinds are **concrete** to what Copilot Studio actually produces. We do NOT
  introduce a generic `WorkflowNode` superclass or speculative kinds
  (Switch/Parallel/Retry/Timer) — add kinds when a real source needs them.
- **VALIDATED** against 454 real topics: parser implemented in
  `server/src/services/topicGraph.ts`, 95.8% validate clean, 2,935 nodes, 3.1%
  unknown (preserved losslessly via `rawKind`). Real AdaptiveDialog kinds observed
  and mapped: SendActivity/MessageBack→message; Question/CSATQuestion/OAuthInput→
  question; ConditionGroup→condition; Foreach→loop; SetVariable/SetTextVariable/
  ParseValue/ClearAllVariables→setVar; BeginDialog/ReplaceDialog/GotoAction→goto;
  EndDialog/EndConversation/CancelAllDialogs/BreakLoop→end; Invoke*Action/
  HttpRequestAction/Search*→action. Remaining 4% are YAML parse edge cases
  (`@odata` keys, escaped-quote compact mappings) — raw preserved, graph deferred.
- `action` nodes never inline a connector/flow/model; they reference a
  `dependencyId` (§6).
- `next`/`then`/`else`/`body`/`target` are the edges. Absent `next` = fall through
  to topic end.

---

## 5. Presentation (kept out of behavior)

```ts
interface PresentationAsset {
  id: string;
  kind: 'adaptive-card' | 'buttons' | 'image' | 'rich-text';
  raw: unknown;                         // original card JSON, preserved losslessly
  blocks?: { type: 'text' | 'factset' | 'actionset'; content: unknown }[]; // parsed for mapping
}
```

`message` nodes point at a presentation asset via `presentationId`. The mapper
decides: rich response, markdown, or manual — and reports which.

---

## 6. Dependencies (first-class)

```ts
interface DependencyIR {
  id: string;                           // referenced by action nodes / tools
  type: 'power-automate-flow' | 'connector' | 'ai-builder-model' | 'child-agent' | 'dataverse-table';
  ref: string;                          // source id
  name?: string;
  detail?: unknown;                     // e.g. the flow's own captured graph
}
```

One dependency, referenced by many nodes. Enables impact analysis, reporting, and
(later) migration ordering — without embedding duplicated blobs in nodes.

---

## 7. Validation rules (parser output MUST satisfy)

A validator runs after every parse. An IR is invalid if any fail:

1. `schemaVersion === 2`.
2. Every `TopicIR.rootNodeId` exists in `nodes`.
3. Every edge (`next`/`then`/`else`/`body`/`target`) points to an existing node id.
4. No orphan nodes (unreachable from root) — warn, don't fail.
5. No cycles except through a `loop` node's `body`.
6. Every variable referenced (`storeIn`/`overVar`/`itemVar`/`target`/`expr`) is
   declared in `variables` (topic or global scope).
7. Every `action.dependencyId` resolves to a `dependencies[]` entry.
8. Every `message.presentationId` resolves to the topic's `presentation[]`.

Validation failures are surfaced, never swallowed.

---

## 8. Extraction vs. transformation (the boundary)

| Belongs in **extraction** (parser → IR) | Belongs in **transformation** (mapper → target) |
|---|---|
| Read every botcomponent; parse topic YAML into the node graph | Decide how a node graph becomes Gemini instruction vs. ADK code |
| Capture the real `instructions`, variables, entities, deps | Map model name → Gemini model (or warn) |
| Preserve Adaptive Card JSON verbatim | Render card → rich response / markdown / manual |
| Record knowledge *source references* | Create data store + trigger ingestion |
| Detect dependencies (flows/connectors/models) | Rebuild a flow as a Cloud Function / ADK tool |

Rule of thumb: **if it removes information, it belongs in the mapper, and it must
emit a fidelity note.**

---

## 9. Target strategy — Gemini Enterprise (informative, not part of the contract)

How the Gemini mapper is expected to treat each construct (assessment mirrors this):

| IR construct | Gemini treatment | Fidelity |
|---|---|---|
| `instructions`, name, description, starterPrompts | agent fields | full |
| `model.source` | mapped Gemini model | full (+warn) |
| `capabilities.webBrowsing` | `googleSearch` tool | full |
| simple `message`/`question`/`condition` | folded into instruction | partial |
| deterministic branch/loop/flow that must be exact | generated ADK code / Cloud Function tool | full-via-rebuild |
| `tools` (connector/http) | Gemini tool w/ schema | partial |
| `knowledge` | data store (re-ingest) | partial (v2) |
| Adaptive Card | rich response or markdown | partial |
| `channels`, `auth` | reported for manual setup | none (report) |
| Gemini `activeRevision`, `agentIdentityInfo` (SPIFFE) | target-generated | n/a |

---

## 10. Explicitly out of scope (deferred, by decision)

To avoid over-engineering, the following are **not** part of v2 and are added only
when a customer or a second platform forces them:

- Generic `WorkflowNode` superclass / speculative node kinds.
- Additional target mappers (Vertex, Amazon Q, Azure) — the IR permits them; we
  don't build them.
- IR schema-migration tooling (only the `schemaVersion` field exists now).
- Rollback engine and dependency *ordering*/scheduling.
- Large-scale execution (job queue / resume) — orthogonal; tracked separately.

---

## 11. Relationship to current code

- `server/src/types.ts` currently defines a **summary-grade** `TopicIR`
  (`summary`, `messages`, flags). v2 replaces that with the graph model above.
- `server/src/services/dataverse.ts` already fetches the raw AdaptiveDialog YAML
  into `TopicIR.raw`; the v2 parser turns that raw YAML into `nodes[]`.
- `server/src/services/assessment.ts` and `mapper.ts` already encode §9's spirit;
  once the graph exists they read node counts/kinds for accurate effort + fidelity.
