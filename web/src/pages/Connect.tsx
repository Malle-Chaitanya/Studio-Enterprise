import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchSession, googleStartUrl } from '../api.ts';
import type { SessionSummary } from '../types.ts';

export function Connect() {
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) {
      setError('Missing session');
      return;
    }
    fetchSession(session)
      .then(setSummary)
      .catch(() => setError('Session expired — please start over.'));
  }, [session]);

  if (error) {
    return (
      <div className="card">
        <div className="logo">
          Cloud<span>Fuze</span>
        </div>
        <div className="error">{error}</div>
        <a className="btn primary" href="/">
          Start over
        </a>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="card">
        <p className="lead">Loading tenant…</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="logo">
        Cloud<span>Fuze</span>
      </div>

      <div className="steps">
        <div className="step">
          <div className="num done">✓</div>
          <div>
            <strong>Microsoft connected</strong>
          </div>
        </div>
        <div className="step">
          <div className="num active">2</div>
          <div>
            <strong>Explore or migrate</strong>
          </div>
        </div>
      </div>

      <div className="infobox">
        <div className="org">{summary.orgName}</div>
        <div className="mono">{summary.tenantId}</div>
        <div className="mono">{summary.environments} environment(s) found</div>
      </div>

      <div className="rows">
        <div className="row">
          <span>Copilot Studio agents</span>
          <span className="val">{summary.botCount}</span>
        </div>
        <div className="row">
          <span>Topics</span>
          <span className="val">{summary.topicCount}</span>
        </div>
        <div className="row">
          <span>Knowledge sources</span>
          <span className="val">{summary.ksCount}</span>
        </div>
        <div className="row">
          <span>Power Automate flows (later phase)</span>
          <span className="val">{summary.flowCount}</span>
        </div>
      </div>

      <p className="lead">
        Explore and assess your environments first (recommended), or connect Google to migrate now.
      </p>
      <a className="btn primary" href={`/explore?session=${session}`}>
        Explore &amp; assess environments
      </a>
      <a className="btn google" href={googleStartUrl(session)} style={{ marginTop: 10 }}>
        Connect Google &amp; migrate
      </a>
    </div>
  );
}
