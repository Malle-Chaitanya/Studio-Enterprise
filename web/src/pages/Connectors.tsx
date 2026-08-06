import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fetchConnectorsNeeded, fetchEnvironments, type ConnectorNeeded } from '../api.ts';
import { ConnectorSetup } from '../components/ConnectorSetup.tsx';
import type { EnvironmentInfo } from '../types.ts';

interface Row extends ConnectorNeeded {
  envName: string;
}

function kindIcon(kind: string): string {
  return kind === 'onedrive-connector' ? '☁️' : '🔗';
}

/**
 * The "batch" connector view: ONE flat list of every SharePoint/OneDrive site
 * that needs a native connector, across every accessible environment, with
 * every agent that references it — instead of clicking into agents one at a
 * time on the Explore page to find the same information. Built directly in
 * response to that being a real usability complaint (too many clicks for a
 * task that's really "here's what needs setting up, go set it up").
 */
export function Connectors() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';

  const [scanning, setScanning] = useState(true);
  const [scannedCount, setScannedCount] = useState(0);
  const [totalEnvs, setTotalEnvs] = useState(0);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const envs = (await fetchEnvironments(session).catch(() => [] as EnvironmentInfo[])).filter(
        (e) => e.accessible && (e.knowledgeSources ?? 0) > 0,
      );
      if (cancelled) return;
      setTotalEnvs(envs.length);

      const all: Row[] = [];
      // Sequential per environment (each call already fans out across that
      // environment's agents server-side with bounded concurrency) — keeps a
      // simple, readable progress count instead of racing several big scans
      // against each other.
      for (const env of envs) {
        try {
          const found = await fetchConnectorsNeeded(session, env.url);
          for (const c of found) all.push({ ...c, envName: env.name });
        } catch {
          // one environment failing (e.g. transient 403) shouldn't blank the
          // whole page — the rest still render, and we're honest about total scanned.
        }
        if (!cancelled) setScannedCount((n) => n + 1);
      }
      if (!cancelled) {
        setRows(all);
        setScanning(false);
      }
    })().catch(() => {
      if (!cancelled) {
        setError('Could not scan environments for connectors. Make sure Microsoft is connected.');
        setScanning(false);
      }
    });
    return () => { cancelled = true; };
  }, [session]);

  return (
    <div className="card wide">
      <h2>Connectors needed</h2>
      <p className="lead">
        Every SharePoint/OneDrive site that needs a native connector set up before it can migrate —
        across all your environments, in one list. Set each one up once here; every agent that uses
        it picks it up automatically.
      </p>

      {error && <div className="error">{error}</div>}

      {scanning && (
        <p className="lead">
          Scanning agents for connector needs… ({scannedCount}/{totalEnvs} environment{totalEnvs === 1 ? '' : 's'})
        </p>
      )}

      {!scanning && rows && rows.length === 0 && (
        <div className="infobox">Nothing needs a connector right now — every knowledge source either migrates
          automatically or has already been set up.</div>
      )}

      {!scanning && rows && rows.length > 0 && (
        <div className="ksgrid">
          {rows.map((r, i) => (
            <div key={`${r.kind}::${r.siteUrl}::${i}`} className="kscard">
              <div className="kscard-top">
                <span className="ksicon">{kindIcon(r.kind)}</span>
                <span className="kstitle">{r.siteUrl}</span>
                <span className="tag partial">{r.envName}</span>
              </div>
              <p className="ksdetail">
                Used by: {r.agentNames.join(', ')}
              </p>
              {r.kind === 'sharepoint-connector' ? (
                <ConnectorSetup session={session} siteUrl={r.siteUrl} />
              ) : (
                <p className="kswarn">⚠ OneDrive connector setup isn't built yet — Google's exact connector
                  identifier for OneDrive hasn't been verified. Flagged for manual follow-up.</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="wizard-actions" style={{ marginTop: 20 }}>
        <button className="wbtn" onClick={() => navigate(`/connector-config?session=${session}`)}>← Back</button>
        <button className="wbtn primary" onClick={() => navigate(`/migrate?session=${session}`)}>Continue →</button>
      </div>
    </div>
  );
}
