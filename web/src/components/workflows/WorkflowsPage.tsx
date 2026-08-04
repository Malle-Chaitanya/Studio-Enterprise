import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchWorkflows } from '../../api.ts';
import { WorkflowCard } from './WorkflowCard.tsx';
import { WorkflowTrigger } from './WorkflowTrigger.tsx';
import { Toast, type ToastState } from '../ui/Toast.tsx';
import type { WorkflowInfo } from '../../types.ts';

export function WorkflowsPage() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';

  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [triggering, setTriggering] = useState<WorkflowInfo | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    fetchWorkflows(session)
      .then(setWorkflows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load workflows'))
      .finally(() => setLoading(false));
  }, [session]);

  const filtered = workflows.filter(
    (w) =>
      w.name.toLowerCase().includes(search.toLowerCase()) ||
      (w.description ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="wfp-root">
      <div className="wfp-header">
        <div>
          <div className="wfp-title">Cloud Workflows</div>
          <div className="wfp-subtitle">
            Migrated workflows from Copilot Studio — run, monitor, and manage.
          </div>
        </div>
        <button
          className="btn-outline"
          onClick={() => {
            setLoading(true);
            fetchWorkflows(session)
              .then(setWorkflows)
              .catch(() => {})
              .finally(() => setLoading(false));
          }}
          disabled={loading}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
          </svg>
          Refresh
        </button>
      </div>

      {/* Search */}
      <div className="wfp-search-wrap">
        <svg className="wfp-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          className="wfp-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search workflows…"
        />
      </div>

      {/* States */}
      {loading && (
        <div className="wfp-empty">
          <span className="spinner-sm" />
          Loading workflows…
        </div>
      )}

      {!loading && error && (
        <div className="wfp-error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          {error}
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="wfp-empty">
          {search ? `No workflows matching "${search}"` : 'No workflows found. Complete a migration first.'}
        </div>
      )}

      {/* Grid */}
      {!loading && !error && filtered.length > 0 && (
        <div className="wfp-grid">
          {filtered.map((wf) => (
            <WorkflowCard key={wf.name} workflow={wf} onTrigger={setTriggering} />
          ))}
        </div>
      )}

      {/* Trigger modal */}
      <WorkflowTrigger
        workflow={triggering}
        session={session}
        onClose={() => setTriggering(null)}
        onDone={(msg) => {
          setTriggering(null);
          setToast({ message: 'Workflow completed', type: 'success', id: Date.now() });
          void msg;
        }}
      />

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onHide={() => setToast(null)}
        />
      )}
    </div>
  );
}
