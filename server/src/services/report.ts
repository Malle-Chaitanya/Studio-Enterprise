import type { MigrationResult } from '../types.js';

/** Build a human-readable migration report (markdown) from results. */
export function renderReport(orgName: string, results: MigrationResult[]): string {
  const ok = results.filter((r) => r.created || r.geminiAgentId);
  const failed = results.filter((r) => r.error && !r.geminiAgentId);
  const lines: string[] = [];

  lines.push(`# Migration report — ${orgName}`);
  lines.push('');
  lines.push(`**Agents processed:** ${results.length}  `);
  lines.push(`**Succeeded:** ${ok.length}  `);
  lines.push(`**Deployed:** ${results.filter((r) => r.deployed).length}  `);
  lines.push(`**Left as Draft (source was Draft):** ${results.filter((r) => r.draftPreserved).length}  `);
  lines.push(`**Shared:** ${results.filter((r) => r.shared).length}  `);
  lines.push(`**Verified:** ${results.filter((r) => r.verified).length}  `);
  lines.push(`**Failed:** ${failed.length}`);
  lines.push('');

  for (const r of results) {
    lines.push(`## ${r.name}`);
    lines.push('');
    lines.push(`- Source id: \`${r.sourceId}\``);
    if (r.geminiAgentId) lines.push(`- Gemini agent id: \`${r.geminiAgentId}\``);
    lines.push(`- Status: ${statusLine(r)}`);
    if (r.verifySample) lines.push(`- Sample reply: "${r.verifySample}"`);
    if (r.error) lines.push(`- Error: ${r.error}`);
    if (r.fidelity.length) {
      lines.push('- Fidelity:');
      for (const f of r.fidelity) lines.push(`  - [${f.status}] **${f.component}** — ${f.detail}`);
    }
    lines.push('');
  }

  const needsReview = results.flatMap((r) =>
    r.fidelity.filter((f) => f.status === 'needs-review' || f.status === 'partial' || f.status === 'lost').map((f) => ({ agent: r.name, f })),
  );
  if (needsReview.length) {
    lines.push('## Needs human review');
    lines.push('');
    for (const { agent, f } of needsReview) lines.push(`- **${agent}** — ${f.component}: ${f.detail}`);
    lines.push('');
  }

  return lines.join('\n');
}

function statusLine(r: MigrationResult): string {
  const parts: string[] = [];
  parts.push(r.created || r.geminiAgentId ? 'created ✓' : 'not created ✗');
  parts.push(r.deployed ? 'deployed ✓' : r.draftPreserved ? 'left as Draft (source Draft)' : 'not deployed');
  parts.push(r.shared ? 'shared ✓' : 'not shared');
  if (r.verified !== undefined) parts.push(r.verified ? 'verified ✓' : 'verify failed');
  return parts.join(' · ');
}
