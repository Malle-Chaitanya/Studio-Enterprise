import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchSession } from '../api.ts';
import { GeminiIcon, MsIcon } from '../icons.tsx';
import type { SessionSummary } from '../types.ts';

/**
 * Step 2 — Choose Migration Pair. Single fixed pair (Copilot Studio → Gemini
 * Enterprise) shown with connected badges + the accounts in use, matching the
 * ITSM "Choose Migration Pair" screen.
 */
export function ChoosePair() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const [summary, setSummary] = useState<SessionSummary | null>(null);

  useEffect(() => {
    if (session) fetchSession(session).then(setSummary).catch(() => setSummary(null));
  }, [session]);

  const srcConnected = !!summary?.connected.microsoft;
  const tgtConnected = !!summary?.connected.google;

  return (
    <div className="card wide">
      <h2>Choose Migration Pair</h2>

      <div className="pair-row">
        <div className="pair-card">
          <div className="pair-head">
            <span className="platform-role">Source</span>
            {srcConnected && <span className="conn-pill">connected</span>}
          </div>
          <div style={{ marginTop: 10 }}>
            <MsIcon s={44} />
          </div>
          <div className="pair-name">Copilot Studio</div>
          <div className="pair-account">
            Using account <strong>{summary?.msEmail || summary?.orgName || '—'}</strong>
          </div>
        </div>

        <div className="pair-arrow">→</div>

        <div className="pair-card">
          <div className="pair-head">
            <span className="platform-role">Target</span>
            {tgtConnected && <span className="conn-pill">connected</span>}
          </div>
          <div style={{ marginTop: 10 }}>
            <GeminiIcon s={44} />
          </div>
          <div className="pair-name">Gemini Enterprise</div>
          <div className="pair-account">
            Using account <strong>{summary?.gEmail ?? '—'}</strong>
          </div>
        </div>
      </div>

      <div className="wizard-actions">
        <button className="wbtn" onClick={() => navigate(`/home?session=${session}`)}>
          ← Back
        </button>
        <button className="wbtn primary" onClick={() => navigate(`/map-users?session=${session}`)}>
          Continue →
        </button>
      </div>
    </div>
  );
}
