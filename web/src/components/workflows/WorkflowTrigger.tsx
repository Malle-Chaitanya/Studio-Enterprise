import { useState } from 'react';
import { Modal } from '../ui/Modal.tsx';
import { executeWorkflow } from '../../api.ts';
import type { WorkflowInfo } from '../../types.ts';

interface Props {
  workflow: WorkflowInfo | null;
  session: string;
  onClose: () => void;
  onDone: (result: string) => void;
}

export function WorkflowTrigger({ workflow, session, onClose, onDone }: Props) {
  const [args, setArgs] = useState('{}');
  const [argsError, setArgsError] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!workflow) return null;

  const handleRun = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      setArgsError('Invalid JSON');
      return;
    }
    setArgsError('');
    setRunning(true);
    setResult(null);
    try {
      const res = await executeWorkflow(session, workflow.name, workflow.region ?? 'us-central1', parsed);
      const msg = typeof res.result === 'string' ? res.result : JSON.stringify(res.result, null, 2);
      setResult(msg);
      onDone(msg);
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal open={!!workflow} onClose={onClose} title={`Run: ${workflow.name}`} width={520}>
      <div className="wft-body">
        <div className="wft-field">
          <label className="wft-label">Workflow Arguments (JSON)</label>
          <textarea
            className={`wft-textarea${argsError ? ' wft-textarea-err' : ''}`}
            value={args}
            onChange={(e) => {
              setArgs(e.target.value);
              setArgsError('');
            }}
            rows={6}
            placeholder='{"key": "value"}'
            spellCheck={false}
          />
          {argsError && <span className="wft-error">{argsError}</span>}
        </div>

        {result !== null && (
          <div className={`wft-result${result.startsWith('Error:') ? ' wft-result-err' : ''}`}>
            <div className="wft-result-label">Result</div>
            <pre className="wft-result-pre">{result}</pre>
          </div>
        )}

        <div className="wft-actions">
          <button className="btn-ghost" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button className="btn-primary wft-run-btn" onClick={handleRun} disabled={running}>
            {running ? (
              <>
                <span className="btn-spinner" />
                Running…
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Run
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
