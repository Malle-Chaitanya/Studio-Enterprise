/**
 * A real parser for Microsoft's Workflow Definition Language (WDL) expression syntax —
 * the `@{...}` / bare `@...` grammar used throughout Copilot Studio Agent Flow definitions
 * (Compose templates, Response bodies, Query `from`/`where` clauses, connector parameters).
 *
 * WHY A REAL PARSER, NOT REGEX/STRING-SPLITTING: the earlier hand-built migration spikes
 * this session split templates on `@{triggerBody()?['key']}` literally — that only works for
 * the one shape it was written for. A real flow can reference `outputs('OtherAction')`,
 * nest function calls (`and(lessOrEquals(int(item()['x']), triggerBody()['y']), ...)`), mix
 * safe (`?['key']`) and unsafe (`['key']`) accessors, and wrap a value in a type-cast
 * function (`int(...)`) — all confirmed live in the real Deal Desk flows. A generic
 * translator needs a real grammar, not a pattern matched to one flow.
 *
 * Pure: no I/O, no config, no network. Fully unit-testable.
 */

export type FlowExpr =
  | { kind: 'call'; name: string; args: FlowExpr[] }
  | { kind: 'accessor'; base: FlowExpr; key: string; safe: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  /** Unparseable fragment — preserved verbatim so translation can honestly flag it
   *  instead of silently misinterpreting it. */
  | { kind: 'raw'; text: string };

export type TemplatePart = { kind: 'literal'; text: string } | { kind: 'expr'; expr: FlowExpr };

type Token =
  | { type: 'ident'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: '(' | ')' | '[' | ']' | ',' | '?' | '.' }
  | { type: 'eof' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === '[' || c === ']' || c === ',' || c === '?' || c === '.') {
      tokens.push({ type: c } as Token);
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== "'") {
        // WDL escapes an embedded single quote as ''
        if (src[j] === "'" && src[j + 1] === "'") {
          value += "'";
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: 'number', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    // Unrecognized character — stop tokenizing here; parseExpr falls back to `raw`.
    break;
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(
    private tokens: Token[],
    private source: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }

  /** Parses one full expression plus any trailing accessors (`?['x']`, `['x']`, `.x`). */
  parseExpr(): FlowExpr {
    const primary = this.parsePrimary();
    return this.parseAccessors(primary);
  }

  private parsePrimary(): FlowExpr {
    const t = this.peek();
    if (t.type === 'ident') {
      this.next();
      if (this.peek().type === '(') {
        this.next(); // consume '('
        const args: FlowExpr[] = [];
        if (this.peek().type !== ')') {
          args.push(this.parseExpr());
          while (this.peek().type === ',') {
            this.next();
            args.push(this.parseExpr());
          }
        }
        if (this.peek().type === ')') this.next();
        return { kind: 'call', name: t.value, args };
      }
      // A bare identifier with no call parens — not a shape observed live; preserve raw.
      return { kind: 'raw', text: t.value };
    }
    if (t.type === 'string') {
      this.next();
      return { kind: 'string', value: t.value };
    }
    if (t.type === 'number') {
      this.next();
      return { kind: 'number', value: t.value };
    }
    // Anything else (malformed input, an operator this grammar doesn't cover) is preserved
    // verbatim rather than guessed at.
    return { kind: 'raw', text: this.source.slice(this.pos) };
  }

  private parseAccessors(base: FlowExpr): FlowExpr {
    for (;;) {
      if (this.peek().type === '?' && this.tokens[this.pos + 1]?.type === '[') {
        this.next(); // '?'
        this.next(); // '['
        const keyTok = this.next();
        const key = keyTok.type === 'string' ? keyTok.value : '';
        if (this.peek().type === ']') this.next();
        base = { kind: 'accessor', base, key, safe: true };
        continue;
      }
      if (this.peek().type === '[') {
        this.next();
        const keyTok = this.next();
        const key = keyTok.type === 'string' ? keyTok.value : '';
        if (this.peek().type === ']') this.next();
        base = { kind: 'accessor', base, key, safe: false };
        continue;
      }
      if (this.peek().type === '.' && this.tokens[this.pos + 1]?.type === 'ident') {
        this.next();
        const ident = this.next() as { type: 'ident'; value: string };
        base = { kind: 'accessor', base, key: ident.value, safe: false };
        continue;
      }
      break;
    }
    return base;
  }
}

/** Parses one bare WDL expression (no surrounding literal text), e.g. the contents of an
 *  `@{...}` interpolation, or a whole-value `@expr` field like a Query `where` clause. */
export function parseFlowExpr(src: string): FlowExpr {
  const trimmed = src.trim();
  const parser = new Parser(tokenize(trimmed), trimmed);
  return parser.parseExpr();
}

/**
 * Splits a template string into literal text and `@{...}` expression parts, OR — when the
 * entire trimmed value starts with a single `@` not followed by `{` — treats the whole
 * string (minus the leading `@`) as one expression. Both conventions are used in real WDL
 * (`"@{triggerBody()?['text']}"` inside a larger string; `"@and(...)"` for a pure-expression
 * field like Query's `where`), so both are handled rather than assuming one.
 *
 * `@@` is WDL's escape for a literal `@` character and is unescaped to `@` in literal text.
 */
export function parseTemplate(value: string): TemplatePart[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('@') && !trimmed.startsWith('@{') && !trimmed.startsWith('@@')) {
    return [{ kind: 'expr', expr: parseFlowExpr(trimmed.slice(1)) }];
  }
  const parts: TemplatePart[] = [];
  let i = 0;
  let literal = '';
  while (i < value.length) {
    if (value[i] === '@' && value[i + 1] === '@') {
      literal += '@';
      i += 2;
      continue;
    }
    if (value[i] === '@' && value[i + 1] === '{') {
      // Find the matching close brace. WDL expressions never contain literal `{`/`}`
      // themselves (string literals use single quotes), so a simple scan for the next
      // `}` is safe — same assumption the earlier proven spikes relied on, made explicit
      // and centralized here instead of repeated per caller.
      const close = value.indexOf('}', i + 2);
      if (close === -1) {
        // Unterminated — preserve the rest verbatim rather than losing it.
        literal += value.slice(i);
        break;
      }
      if (literal) {
        parts.push({ kind: 'literal', text: literal });
        literal = '';
      }
      const inner = value.slice(i + 2, close);
      parts.push({ kind: 'expr', expr: parseFlowExpr(inner) });
      i = close + 1;
      continue;
    }
    literal += value[i];
    i++;
  }
  if (literal) parts.push({ kind: 'literal', text: literal });
  return parts;
}

/** True when an expr is a call to one of these names (used to recognize triggerBody()/outputs()/body()/item() roots). */
export function isCallTo(e: FlowExpr, ...names: string[]): e is FlowExpr & { kind: 'call' } {
  return e.kind === 'call' && names.includes(e.name);
}

/** Walks an accessor chain down to its root call, collecting the accessed keys in order
 *  (outermost accessor last). Returns undefined if the base is not ultimately a call. */
export function unwrapAccessors(e: FlowExpr): { root: FlowExpr & { kind: 'call' }; keys: string[] } | undefined {
  const keys: string[] = [];
  let cur = e;
  while (cur.kind === 'accessor') {
    keys.unshift(cur.key);
    cur = cur.base;
  }
  if (cur.kind !== 'call') return undefined;
  return { root: cur, keys };
}
