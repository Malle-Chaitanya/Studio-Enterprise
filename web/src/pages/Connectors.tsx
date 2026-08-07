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
      // Scan ONLY what the customer selected. Scanning every environment listed
      // connectors belonging to agents they never chose — reading as "set all these
      // up" when most were irrelevant — and made the wait proportional to the whole
      // tenant (48 agents per environment) rather than to their selection.
      let selection: Array<{ env: string; botIds: string[] }> = [];
      try {
        selection = JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
      } catch {
        /* fall back to scanning every environment below */
      }
      selection = selection.filter((sel) => sel.botIds?.length);

      const envs = (await fetchEnvironments(session).catch(() => [] as EnvironmentInfo[])).filter(
        (e) => e.accessible && (e.knowledgeSources ?? 0) > 0,
      );
      if (cancelled) return;
      const targets = selection.length
        ? selection.map((sel) => ({
            url: sel.env,
            name: envs.find((e) => e.url === sel.env)?.name ?? sel.env,
            botIds: sel.botIds,
          }))
        : envs.map((e) => ({ url: e.url, name: e.name, botIds: [] as string[] }));
      setTotalEnvs(targets.length);

      // Parallel, not sequential: environments are independent, and waiting for one
      // before starting the next doubled the wall clock for no benefit.
      const results = await Promise.all(
        targets.map(async (t) => {
          try {
            const found = await fetchConnectorsNeeded(session, t.url, t.botIds);
            return found.map((c) => ({ ...c, envName: t.name }));
          } catch {
            // one environment failing (e.g. a transient 403) must not blank the page
            return [] as Row[];
          } finally {
            if (!cancelled) setScannedCount((n) => n + 1);
          }
        }),
      );
      const all: Row[] = results.flat();
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
        <>
          <p className="lead" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="cf-spinner" aria-hidden="true" />
            Scanning your selected agents for connector needs…
            {totalEnvs > 0 && ` (${scannedCount}/${totalEnvs} environment${totalEnvs === 1 ? '' : 's'})`}
          </p>
          {/* Placeholder rows: a bare progress line on an empty page reads as "stuck".
              Showing the shape of the result makes the wait legible. */}
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="card"
              style={{
                padding: '14px 18px', marginBottom: 10, borderLeft: '3px solid var(--border)',
                opacity: 1 - i * 0.25,
              }}
            >
              <div className="cf-skel" style={{ width: '45%', height: 14, marginBottom: 8 }} />
              <div className="cf-skel" style={{ width: '65%', height: 11, marginBottom: 6 }} />
              <div className="cf-skel" style={{ width: '30%', height: 11 }} />
            </div>
          ))}
        </>
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
