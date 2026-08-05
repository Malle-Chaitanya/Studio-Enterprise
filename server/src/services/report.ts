import type { MigrationResult, PermissionHandoff } from '../types.js';

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
  lines.push(`**Shared (auto org-wide):** ${results.filter((r) => r.shared && !r.permissionHandoff).length}  `);
  lines.push(`**Permission handoffs (manual):** ${results.filter((r) => r.permissionHandoff).length}  `);
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
    if (r.permissionHandoff) {
      lines.push('- Permissions (handoff):');
      lines.push(...renderHandoffBullets(r.permissionHandoff));
    }
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

  const handoffs = results.filter((r) => r.permissionHandoff);
  if (handoffs.length) {
    lines.push('## Permissions to apply manually');
    lines.push('');
    lines.push(
      'Gemini agent APIs only support org-wide `ALL_USERS` sharing. Narrower source access is delivered as a mapped checklist — not silently over-shared.',
    );
    lines.push('');
    for (const r of handoffs) {
      const h = r.permissionHandoff!;
      lines.push(`### ${r.name}`);
      lines.push('');
      lines.push(`- Reason: ${h.reason}`);
      if (h.grantUsers.length) lines.push(`- Grant users: ${h.grantUsers.map((e) => `\`${e}\``).join(', ')}`);
      if (h.grantGroups.length) lines.push(`- Grant groups: ${h.grantGroups.map((e) => `\`${e}\``).join(', ')}`);
      if (h.unresolved.length) {
        lines.push('- Unresolved (map or skip):');
        for (const u of h.unresolved) lines.push(`  - ${u.source}: ${u.reason}`);
      }
      lines.push('- Steps:');
      for (const s of h.steps) lines.push(`  1. ${s}`);
      lines.push('');
    }
  }

  const autoShared = results.filter((r) => r.shared && !r.permissionHandoff && (r.created || r.geminiAgentId));
  if (autoShared.length) {
    lines.push('## Auto-applied (org-wide)');
    lines.push('');
    for (const r of autoShared) lines.push(`- **${r.name}** — shared \`ALL_USERS\` (source allowed org-wide chat, or permissions were not extracted).`);
    lines.push('');
  }

  return lines.join('\n');
}

function renderHandoffBullets(h: PermissionHandoff): string[] {
  const lines: string[] = [];
  lines.push(`  - Reason: ${h.reason}`);
  if (h.grantUsers.length) lines.push(`  - Users to grant: ${h.grantUsers.join(', ')}`);
  if (h.grantGroups.length) lines.push(`  - Groups to grant: ${h.grantGroups.join(', ')}`);
  if (h.unresolved.length) {
    lines.push(`  - Unresolved: ${h.unresolved.map((u) => `${u.source} (${u.reason})`).join('; ')}`);
  }
  return lines;
}

function statusLine(r: MigrationResult): string {
  const parts: string[] = [];
  parts.push(r.created || r.geminiAgentId ? 'created ✓' : 'not created ✗');
  parts.push(r.deployed ? 'deployed ✓' : r.draftPreserved ? 'left as Draft (source Draft)' : 'not deployed');
  if (r.permissionHandoff) parts.push('share handoff (manual)');
  else parts.push(r.shared ? 'shared ✓' : 'not shared');
  if (r.verified !== undefined) parts.push(r.verified ? 'verified ✓' : 'verify failed');
  return parts.join(' · ');
}
