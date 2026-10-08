import type {
  ConnectorOpIndex,
  VendorApiMethod,
  VendorApiParameter,
  VendorApiSurface,
} from './operationBinding.js';

/**
 * SEMANTIC equivalence between a Power Platform operation and the vendor call that actually
 * serves it — for the connectors where no amount of path matching can find one.
 *
 * WHY THIS EXISTS. `bindOperation` answers "is this connector's path a vendor path". For
 * roughly half of Google's operations the answer is no, and not because anything is broken:
 * Microsoft published Drive and Sheets on Power Platform's generic file/table vocabulary so
 * one Power Automate UI could drive SharePoint, Dropbox, Box and Drive interchangeably.
 *
 *     connector   GET /datasets/default/files/{id}
 *     vendor      GET https://www.googleapis.com/drive/v3/files/{fileId}
 *
 * Those are the same operation. Nothing about the first string implies the second, so the
 * relationship has to be STATED. Measured on the live tenant, this is 81 of 131 Google
 * operations and the whole reason two of three real customer agents migrate zero tools.
 *
 * WHAT MAKES THIS SAFE. A wrong entry here is the worst failure this codebase can produce:
 * it returns the wrong data instead of an error, which no runtime check catches and no user
 * reports as a bug. So an entry is DATA that gets verified, never code that gets trusted:
 *
 *   structural   this module. The vendor publishes this method; every parameter we send is
 *                one it declares; every parameter it requires is filled; every `{arg}` we
 *                interpolate is a real argument of the source operation. Free, offline,
 *                catches invented parameters, wrong verbs, missing required args.
 *   behavioral   call both sides with the same input and diff. The only check that can
 *                catch a well-formed mapping that returns the WRONG ROWS. Needs a live
 *                test account; see `_probe_map_behavior.ts`.
 *
 * `provenance` records which gates an entry has passed, and the report never calls an entry
 * verified for a gate it has not been through.
 */

/** How far an entry has been proven. Never widened by anything but the gate that proves it. */
export type MapProvenance = 'drafted' | 'structurally-verified' | 'behaviorally-verified';

export interface MappedParameter {
  /** The vendor parameter this fills, by the vendor's own name (`fileId`, `q`, `alt`). */
  to: string;
  in: 'path' | 'query' | 'body';
  /**
   * The value, as a template.
   *
   * `{name}`  interpolates the source operation's argument of that name.
   * `{$name}` interpolates a value captured by an earlier step.
   * Anything else is a literal.
   *
   * It is a template rather than a plain rename because the interesting mappings are not
   * renames: Drive's "list a folder" is a Google query EXPRESSION built from a folder id
   * (`'{folderId}' in parents`), not a folder id in a different slot.
   */
  template: string;
}

export interface MappedStep {
  /** The vendor's own method id — `drive.files.list`. Verified to exist, not assumed. */
  vendorMethodId: string;
  parameters: MappedParameter[];
  /**
   * Values to lift out of this step's response for a later step, as `varName -> JSON path`.
   *
   * Multi-step exists because some Power Platform operations have no single vendor call
   * behind them. `GetFileContentByPath` takes a path; Drive v3 has no path lookup, so it is
   * genuinely a search followed by a fetch. Collapsing that to one call would mean dropping
   * the operation, and the instruction here was to cover all of them.
   */
  capture?: Record<string, string>;
}

export interface OperationMapEntry {
  connectorId: string;
  operationId: string;
  /** Which vendor API the steps belong to. Checked against the resolved surface so an entry
   *  written for `drive` can never be verified against `sheets`. */
  api: string;
  steps: MappedStep[];
  /** Why this mapping is not exact. Surfaced as a `FidelityNote`, never swallowed. */
  notes?: string[];
  provenance: MapProvenance;
}

export interface MapProblem {
  /** Index into `steps`, or -1 for a problem with the entry as a whole. */
  step: number;
  kind:
    | 'api-mismatch'
    | 'no-steps'
    | 'unknown-vendor-method'
    | 'undeclared-parameter'
    | 'missing-required-parameter'
    | 'unknown-source-argument'
    | 'unknown-captured-variable'
    | 'enum-violation'
    | 'body-not-supported';
  detail: string;
}

export type MapVerification =
  | { status: 'verified'; checks: string[] }
  /**
   * Distinct from `rejected` on purpose. "The vendor description we hold does not list this
   * method's parameters" is not evidence the mapping is wrong, and reporting it as a
   * rejection would make an old cache row look like a bad entry.
   */
  | { status: 'cannot-verify'; reason: string }
  | { status: 'rejected'; problems: MapProblem[] };

/** Every `{name}` / `{$name}` a template interpolates. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\$?[^}]+)\}/g)].map((m) => m[1]);
}

/** A template with no placeholders is a constant, and a constant can be enum-checked.
 *  Built fresh rather than shared with the matcher above: `.test()` on a `/g` regex advances
 *  `lastIndex`, so a shared one answers differently every other call. */
function literalValue(template: string): string | undefined {
  return /\{\$?[^}]+\}/.test(template) ? undefined : template;
}

function findMethod(surface: VendorApiSurface, id: string): VendorApiMethod | undefined {
  return surface.methods.find((m) => m.id === id);
}

/**
 * Structural verification of one entry — gate 1 of 2.
 *
 * Everything checked here is checkable from two documents we already hold: the vendor's own
 * published description, and the connector's captured operation index. Nothing here needs a
 * network, a tenant or a credential, so it can run over the whole map in CI.
 *
 * What it deliberately does NOT claim: that the mapping is semantically right. `fileId` is
 * declared whether or not we put the right id in it, and `q` accepts any string Google can
 * parse. That is gate 2's job, and `provenance` keeps the two apart.
 */
export function verifyMapEntry(
  entry: OperationMapEntry,
  surface: VendorApiSurface,
  index: ConnectorOpIndex,
): MapVerification {
  const problems: MapProblem[] = [];
  const checks: string[] = [];

  if (entry.api !== surface.api) {
    return {
      status: 'rejected',
      problems: [{
        step: -1,
        kind: 'api-mismatch',
        detail: `entry targets '${entry.api}' but was verified against '${surface.api}'`,
      }],
    };
  }
  if (!entry.steps.length) {
    return { status: 'rejected', problems: [{ step: -1, kind: 'no-steps', detail: 'entry has no steps' }] };
  }

  const sourceOp = index.operations[entry.operationId];
  if (!sourceOp) {
    return {
      status: 'cannot-verify',
      reason: `connector '${entry.connectorId}' does not declare operation '${entry.operationId}' in this environment`,
    };
  }
  const sourceArgs = new Set(sourceOp.parameters.map((p) => p.name));
  const common = surface.commonParameters ?? [];

  // Variables a later step may reference. Grows as the steps are walked, so a step can only
  // use what an EARLIER step captured — a forward reference is a bug, not a feature.
  const captured = new Set<string>();

  for (const [i, step] of entry.steps.entries()) {
    const method = findMethod(surface, step.vendorMethodId);
    if (!method) {
      problems.push({
        step: i,
        kind: 'unknown-vendor-method',
        detail: `${surface.api} publishes no method '${step.vendorMethodId}'`,
      });
      continue;
    }
    if (method.parameters === undefined) {
      return {
        status: 'cannot-verify',
        reason: `the cached description of '${surface.api}' predates parameter capture; refresh it before verifying`,
      };
    }

    const declared = new Map<string, VendorApiParameter>(
      [...method.parameters, ...common].map((p) => [p.name, p]),
    );
    const filled = new Set<string>();

    for (const param of step.parameters) {
      if (param.in === 'body') {
        // A body field is not in Discovery's `parameters` block — the request schema
        // describes it. We can still check the method ACCEPTS a body at all, which catches
        // a mapping that POSTs a payload to a method the vendor declares as a plain GET.
        if (!method.hasBody) {
          problems.push({
            step: i,
            kind: 'body-not-supported',
            detail: `'${step.vendorMethodId}' declares no request body, but the entry sends '${param.to}' in one`,
          });
        }
      } else {
        const spec = declared.get(param.to);
        if (!spec) {
          problems.push({
            step: i,
            kind: 'undeclared-parameter',
            detail: `'${step.vendorMethodId}' does not declare a parameter named '${param.to}'`,
          });
        } else {
          filled.add(param.to);
          const literal = literalValue(param.template);
          if (literal !== undefined && spec.enum && !spec.enum.includes(literal)) {
            problems.push({
              step: i,
              kind: 'enum-violation',
              detail: `'${param.to}' = '${literal}' is not one of ${spec.enum.join(', ')}`,
            });
          }
        }
      }

      for (const name of placeholders(param.template)) {
        if (name.startsWith('$')) {
          if (!captured.has(name.slice(1))) {
            problems.push({
              step: i,
              kind: 'unknown-captured-variable',
              detail: `'${param.to}' interpolates '${name}', which no earlier step captures`,
            });
          }
        } else if (!sourceArgs.has(name)) {
          problems.push({
            step: i,
            kind: 'unknown-source-argument',
            detail: `'${param.to}' interpolates '{${name}}', which is not an argument of ${entry.operationId}`,
          });
        }
      }
    }

    for (const spec of method.parameters) {
      if (spec.required && !filled.has(spec.name)) {
        problems.push({
          step: i,
          kind: 'missing-required-parameter',
          detail: `'${step.vendorMethodId}' requires '${spec.name}', which the entry never fills`,
        });
      }
    }

    for (const name of Object.keys(step.capture ?? {})) captured.add(name);
    checks.push(`${step.vendorMethodId}: ${method.httpMethod} ${method.url}`);
  }

  if (problems.length) return { status: 'rejected', problems };
  return { status: 'verified', checks };
}

/** Index a map for lookup. Later entries win, so a reviewed override can sit after a draft. */
export function indexOperationMap(entries: OperationMapEntry[]): Map<string, OperationMapEntry> {
  const out = new Map<string, OperationMapEntry>();
  for (const e of entries) out.set(`${e.connectorId}::${e.operationId}`, e);
  return out;
}

export function lookupMapEntry(
  map: Map<string, OperationMapEntry>,
  connectorId: string,
  operationId: string,
): OperationMapEntry | undefined {
  return map.get(`${connectorId}::${operationId}`);
}
