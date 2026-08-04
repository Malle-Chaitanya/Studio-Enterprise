import type { WorkflowInfo } from '../../types.ts';

interface Props {
  workflow: WorkflowInfo;
  onTrigger: (wf: WorkflowInfo) => void;
}

const STATE_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  DISABLED: 'Disabled',
  DEPLOYING: 'Deploying',
  UNKNOWN: 'Unknown',
};

function StatusBadge({ state }: { state: string }) {
  const active = state === 'ACTIVE';
  return (
    <span className={`wf-badge ${active ? 'wf-badge-active' : 'wf-badge-other'}`}>
      <span className={`wf-badge-dot ${active ? 'wf-dot-active' : 'wf-dot-other'}`} />
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

function fmtDate(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function WorkflowCard({ workflow, onTrigger }: Props) {
  return (
    <div className="wf-card">
      <div className="wf-card-top">
        <div className="wf-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        </div>
        <div className="wf-info">
          <div className="wf-name">{workflow.name}</div>
          {workflow.description && <div className="wf-desc">{workflow.description}</div>}
        </div>
        <StatusBadge state={workflow.state} />
      </div>

      <div className="wf-card-meta">
        <span className="wf-meta-item">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          Updated {fmtDate(workflow.updateTime)}
        </span>
        {workflow.region && (
          <span className="wf-meta-item">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            {workflow.region}
          </span>
        )}
      </div>

      <button
        className="wf-trigger-btn"
        onClick={() => onTrigger(workflow)}
        disabled={workflow.state !== 'ACTIVE'}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        Run Workflow
      </button>
    </div>
  );
}
