/**
 * `tsc` copies .ts to .js and nothing else, so the committed connector operation indexes
 * (src/connectors/fixtures/*.ops.json) would be missing from a production build and every
 * connector would report "not captured". This copies them next to the compiled code.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const pairs = [['src/connectors/fixtures', 'dist/connectors/fixtures']];
for (const [from, to] of pairs) {
  if (!existsSync(from)) continue;
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
