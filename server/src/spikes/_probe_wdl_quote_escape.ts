import { parseFlowExpr } from '../services/flowExpression.js';

// WDL escapes an embedded single quote by doubling it. The tokenizer has a branch
// that claims to handle this; the question is whether it is reachable.
const cases = [
  "concat('plain')",
  "concat('it''s')",                 // one escaped quote
  "concat('a''b''c')",               // several
  "concat('Customer''s order', 'x')" // escape plus a following argument
];
for (const src of cases) {
  let out: string;
  try {
    out = JSON.stringify(parseFlowExpr(src));
  } catch (e) {
    out = 'THREW: ' + (e as Error).message;
  }
  console.log(src.padEnd(36), '->', out.slice(0, 160));
}

console.log('--- unterminated / edge ---');
for (const src of ["concat('unterminated", "concat('')", "concat('a', 'b')", "''"]) {
  let out: string;
  try { out = JSON.stringify(parseFlowExpr(src)); } catch (e) { out = 'THREW: ' + (e as Error).message; }
  console.log(JSON.stringify(src).padEnd(28), '->', out.slice(0, 140));
}
