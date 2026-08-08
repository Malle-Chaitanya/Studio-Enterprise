import ExcelJS from 'exceljs';
import type { MigrationResult } from '../types.js';

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2933' } };
const HEADER_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FFFFFFFF' }, bold: true };
const CONFLICT_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7E7' } };

function styleHeaderRow(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });
  row.commit();
}

function statusText(r: MigrationResult): string {
  const parts: string[] = [];
  parts.push(r.created || r.geminiAgentId ? 'created' : 'not created');
  parts.push(r.deployed ? 'deployed' : r.draftPreserved ? 'left as Draft (source Draft)' : 'not deployed');
  if (r.permissionHandoff) parts.push('share handoff (manual)');
  else parts.push(r.shared ? 'shared' : 'not shared');
  if (r.verified !== undefined) parts.push(r.verified ? 'verified' : 'verify failed');
  return parts.join(' | ');
}

/** True when the error is a name conflict (agent already exists at the destination) rather than a hard failure. */
function isConflict(r: MigrationResult): boolean {
  return r.error === 'already exists' || (r.error?.toLowerCase().includes('already exists') ?? false);
}

/** Build the migration report as an Excel workbook (.xlsx) from results. */
export async function renderReportExcel(orgName: string, results: MigrationResult[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CloudFuze Studio Migrate';
  wb.created = new Date();

  const conflicts = results.filter(isConflict);
  const otherFailed = results.filter((r) => r.error && !isConflict(r));

  // --- Summary sheet ---
  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 40 },
    { header: 'Count', key: 'count', width: 12 },
  ];
  styleHeaderRow(summary.getRow(1));
  summary.addRows([
    { metric: `Organization`, count: orgName },
    { metric: 'Agents processed', count: results.length },
    { metric: 'Succeeded', count: results.filter((r) => r.created || r.geminiAgentId).length },
    { metric: 'Deployed', count: results.filter((r) => r.deployed).length },
    { metric: 'Left as Draft (source was Draft)', count: results.filter((r) => r.draftPreserved).length },
    { metric: 'Shared (auto org-wide)', count: results.filter((r) => r.shared && !r.permissionHandoff).length },
    { metric: 'Permission handoffs (manual)', count: results.filter((r) => r.permissionHandoff).length },
    { metric: 'Verified', count: results.filter((r) => r.verified).length },
    { metric: 'Conflicts (already exists — skipped)', count: conflicts.length },
    { metric: 'Other failures', count: otherFailed.length },
  ]);

  // --- Agents sheet: one row per agent, with a dedicated conflict/error column ---
  const agents = wb.addWorksheet('Agents');
  agents.columns = [
    { header: 'Agent name', key: 'name', width: 32 },
    { header: 'Source id', key: 'sourceId', width: 24 },
    { header: 'Gemini agent id', key: 'geminiAgentId', width: 24 },
    { header: 'Status', key: 'status', width: 48 },
    { header: 'Verify sample', key: 'verifySample', width: 32 },
    { header: 'Error / Conflict', key: 'error', width: 44 },
    { header: 'Fidelity notes', key: 'fidelity', width: 60 },
  ];
  styleHeaderRow(agents.getRow(1));
  for (const r of results) {
    const row = agents.addRow({
      name: r.name,
      sourceId: r.sourceId,
      geminiAgentId: r.geminiAgentId ?? '',
      status: statusText(r),
      verifySample: r.verifySample ?? '',
      error: r.error ?? '',
      fidelity: r.fidelity.map((f) => `[${f.status}] ${f.component} — ${f.detail}`).join('\n'),
    });
    if (r.error) {
      const cell = row.getCell('error');
      cell.fill = CONFLICT_FILL;
      cell.alignment = { wrapText: true };
    }
    row.getCell('fidelity').alignment = { wrapText: true };
    row.commit();
  }
  agents.getColumn('fidelity').alignment = { wrapText: true };

  // --- Conflicts & errors sheet: only agents with a conflict/failure ---
  const failedSheet = wb.addWorksheet('Conflicts & Errors');
  failedSheet.columns = [
    { header: 'Agent name', key: 'name', width: 32 },
    { header: 'Source id', key: 'sourceId', width: 24 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Detail', key: 'detail', width: 60 },
  ];
  styleHeaderRow(failedSheet.getRow(1));
  for (const r of conflicts) {
    failedSheet.addRow({ name: r.name, sourceId: r.sourceId, type: 'Conflict', detail: 'Agent already exists at destination — skipped (no duplicate created).' });
  }
  for (const r of otherFailed) {
    failedSheet.addRow({ name: r.name, sourceId: r.sourceId, type: 'Error', detail: r.error });
  }
  failedSheet.getColumn('detail').alignment = { wrapText: true };

  // --- Needs human review sheet: partial/lost/needs-review fidelity notes ---
  const needsReview = wb.addWorksheet('Needs review');
  needsReview.columns = [
    { header: 'Agent name', key: 'name', width: 32 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Component', key: 'component', width: 28 },
    { header: 'Detail', key: 'detail', width: 70 },
  ];
  styleHeaderRow(needsReview.getRow(1));
  for (const r of results) {
    for (const f of r.fidelity) {
      if (f.status === 'needs-review' || f.status === 'partial' || f.status === 'lost') {
        needsReview.addRow({ name: r.name, status: f.status, component: f.component, detail: f.detail }).getCell('detail').alignment = { wrapText: true };
      }
    }
  }

  // --- Permissions to apply manually sheet ---
  const handoffs = results.filter((r) => r.permissionHandoff);
  if (handoffs.length) {
    const perms = wb.addWorksheet('Permissions (manual)');
    perms.columns = [
      { header: 'Agent name', key: 'name', width: 32 },
      { header: 'Reason', key: 'reason', width: 40 },
      { header: 'Grant users', key: 'grantUsers', width: 40 },
      { header: 'Grant groups', key: 'grantGroups', width: 40 },
      { header: 'Unresolved', key: 'unresolved', width: 50 },
      { header: 'Steps', key: 'steps', width: 60 },
    ];
    styleHeaderRow(perms.getRow(1));
    for (const r of handoffs) {
      const h = r.permissionHandoff!;
      const row = perms.addRow({
        name: r.name,
        reason: h.reason,
        grantUsers: h.grantUsers.join(', '),
        grantGroups: h.grantGroups.join(', '),
        unresolved: h.unresolved.map((u) => `${u.source}: ${u.reason}`).join('\n'),
        steps: h.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      });
      row.eachCell((cell) => (cell.alignment = { wrapText: true }));
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
