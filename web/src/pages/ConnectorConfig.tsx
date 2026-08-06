import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchThirdPartyConnectors,
  fetchKnowledgeSourceConnectors,
  saveConnectorCredentials,
  saveMsConnectorCredentials,
  fetchSavedConnectors,
  type DetectedConnector,
} from '../api.ts';

// ── Shared input styles ───────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 10px',
  fontSize: 13,
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--surface)',
  color: 'var(--text)',
  outline: 'none',
};

// ── MS Native connector section ───────────────────────────────────────────────

const MS_NATIVE_FIELDS = [
  { key: 'tenant_id',     label: 'Tenant ID',      type: 'text'     as const, hint: 'Azure Portal → Azure Active Directory → Properties → Directory (tenant) ID' },
  { key: 'client_id',     label: 'App (Client) ID', type: 'text'    as const, hint: 'Azure Portal → App registrations → your app → Application (client) ID' },
  { key: 'client_secret', label: 'Client Secret',   type: 'password' as const, hint: 'Azure Portal → App registrations → Certificates & secrets → New client secret' },
];

const MS_CONNECTOR_LABELS: Record<string, { icon: string; name: string }> = {
  shared_teams:           { icon: '🟣', name: 'Microsoft Teams' },
  shared_office365:       { icon: '📧', name: 'Office 365 / Exchange' },
  shared_sharepointonline:{ icon: '📂', name: 'SharePoint Online' },
  shared_onedrive:        { icon: '☁️', name: 'OneDrive' },
  shared_dynamicscrmonline:{ icon: '💎', name: 'Dynamics 365 / Dataverse' },
  shared_planner:         { icon: '📋', name: 'Microsoft Planner' },
  shared_excelonline:     { icon: '📊', name: 'Excel Online' },
};

function MsNativeSection({ session, detectedMsIds }: { session: string; detectedMsIds: string[] }) {
  const [values, setValues] = useState<Record<string, string>>({ tenant_id: '', client_id: '', client_secret: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [showHint, setShowHint] = useState<string | null>(null);

  if (detectedMsIds.length === 0) return null;

  const allFilled = MS_NATIVE_FIELDS.every((f) => values[f.key]?.trim());

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await saveMsConnectorCredentials(session, values);
      setSaved(true);
    } catch {
      setError('Failed to save. Check that Google is connected and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: '18px 20px', marginBottom: 12, opacity: saved ? 0.7 : 1, transition: 'opacity 0.2s' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 22 }}>🔷</span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 15 }}>Microsoft 365 Connectors</strong>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#0052cc', borderRadius: 4, padding: '1px 6px', textTransform: 'uppercase' }}>
              ms-native
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
            {detectedMsIds.map((id) => {
              const m = MS_CONNECTOR_LABELS[id];
              return m ? <span key={id} style={{ marginRight: 8 }}>{m.icon} {m.name}</span> : null;
            })}
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6, marginBottom: 0 }}>
            Create a single <strong>Azure App Registration</strong> in your tenant with the permissions
            these connectors need. The migrated Gemini agents will use these credentials to call
            Microsoft Graph at runtime.
          </p>
        </div>
        {saved && <span style={{ color: 'var(--ok)', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>✓ Saved</span>}
      </div>

      {!saved && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {MS_NATIVE_FIELDS.map((field) => (
              <div key={field.key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>{field.label}</label>
                  {field.hint && (
                    <button
                      type="button"
                      onClick={() => setShowHint(showHint === field.key ? null : field.key)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 13, padding: 0 }}
                    >ⓘ</button>
                  )}
                </div>
                {showHint === field.key && field.hint && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', marginBottom: 6 }}>
                    {field.hint}
                  </div>
                )}
                <input
                  type={field.type === 'password' ? 'password' : 'text'}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  style={inputStyle}
                />
              </div>
            ))}
          </div>

          {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 8 }}>{error}</div>}

          <div style={{ marginTop: 14 }}>
            <a
              href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade"
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, color: 'var(--brand)', marginRight: 16 }}
            >
              Create App Registration ↗
            </a>
            <button className="wbtn primary" style={{ fontSize: 12, padding: '6px 16px' }}
              disabled={saving || !allFilled} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save credentials'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Third-party connector card ────────────────────────────────────────────────

const CATEGORY_COLOR: Record<string, string> = {
  crm: '#0052cc', itsm: '#de350b', project: '#36b37e', messaging: '#6554c0',
  storage: '#ff8b00', marketing: '#ff5630', payments: '#00875a',
  devops: '#344563', productivity: '#403294', other: '#6b7280',
};

interface ConnectorCardProps {
  c: DetectedConnector;
  session: string;
  /** Already configured in a previous session — credentials are in Secret Manager. */
  alreadySaved?: boolean;
}

function ConnectorCard({ c, session, alreadySaved }: ConnectorCardProps) {
  const { def, flowCount, flowNames } = c;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(def.credentials.map((f) => [f.key, ''])));
  const [saving, setSaving] = useState(false);
  // Start "saved" when this customer configured the connector before, so a
  // returning admin is not asked to re-enter credentials that already exist in
  // Secret Manager. Values are never sent back to the browser — only the fact.
  const [saved, setSaved] = useState(!!alreadySaved);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState('');
  const [showHint, setShowHint] = useState<string | null>(null);

  const allFilled = def.credentials.every((f) => values[f.key]?.trim());

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      await saveConnectorCredentials(session, c.connectorId, def.credentials.map((f) => ({ field: f.key, value: values[f.key] })));
      setSaved(true);
    } catch {
      setError('Failed to save. Check Google is connected and try again.');
    } finally { setSaving(false); }
  };

  return (
    <div className="card" style={{ padding: '18px 20px', marginBottom: 12, opacity: skipped ? 0.5 : 1, transition: 'opacity 0.2s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 24 }}>{def.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 15 }}>{def.name}</strong>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: CATEGORY_COLOR[def.category] ?? '#6b7280', borderRadius: 4, padding: '1px 6px', textTransform: 'uppercase' }}>
              {def.category}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {c.connectorId === 'shared_confluence' ? (
              <span>
                {flowCount} knowledge source{flowCount !== 1 ? 's' : ''}
                {flowNames.length > 0 && (
                  <span title={flowNames.join(', ')}>
                    {' '}· {flowNames.slice(0, 2).join(', ')}{flowNames.length > 2 ? ` +${flowNames.length - 2} more` : ''}
                  </span>
                )}
                {' '}— Confluence spaces will be crawled and indexed for this agent.
              </span>
            ) : (
              <>
                {flowCount} flow{flowCount !== 1 ? 's' : ''}
                {flowNames.length > 0 && (
                  <span title={flowNames.join(', ')}>
                    {' '}· {flowNames.slice(0, 2).join(', ')}{flowNames.length > 2 ? ` +${flowNames.length - 2} more` : ''}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        {saved && <span style={{ color: 'var(--ok)', fontSize: 13, fontWeight: 600 }}>✓ Saved</span>}
        {skipped && <span style={{ color: '#f59e0b', fontSize: 13, fontWeight: 600 }}>⚠ Skipped</span>}
      </div>

      {!saved && !skipped && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {def.credentials.map((field) => (
              <div key={field.key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>{field.label}</label>
                  {field.hint && (
                    <button type="button" onClick={() => setShowHint(showHint === field.key ? null : field.key)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 13, padding: 0 }}>ⓘ</button>
                  )}
                </div>
                {showHint === field.key && field.hint && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', marginBottom: 6 }}>
                    {field.hint}
                  </div>
                )}
                <input
                  type={field.type === 'password' ? 'password' : 'text'}
                  value={values[field.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                  placeholder={field.placeholder ?? ''}
                  style={inputStyle}
                />
              </div>
            ))}
          </div>
          {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
            <button className="wbtn primary" style={{ fontSize: 12, padding: '6px 16px' }}
              disabled={saving || !allFilled} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save credentials'}
            </button>
            <button className="wbtn" style={{ fontSize: 12, padding: '6px 16px' }}
              disabled={saving} onClick={() => setSkipped(true)}>
              Skip (flag for review)
            </button>
            {def.docsUrl && (
              <a href={def.docsUrl} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>Docs ↗</a>
            )}
          </div>
        </>
      )}

      {saved && (
        <button className="wbtn" style={{ fontSize: 11, padding: '4px 12px', marginTop: 6 }}
          onClick={() => { setSaved(false); setValues(Object.fromEntries(def.credentials.map((f) => [f.key, '']))); }}>
          Edit
        </button>
      )}
    </div>
  );
}

// ── MS native connector IDs set ───────────────────────────────────────────────

const MS_NATIVE_IDS = new Set(Object.keys(MS_CONNECTOR_LABELS));

// ── Page ──────────────────────────────────────────────────────────────────────

export function ConnectorConfig() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const session = params.get('session') ?? '';

  const [loading, setLoading] = useState(true);
  const [connectors, setConnectors] = useState<DetectedConnector[]>([]);
  const [msIds, setMsIds] = useState<string[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!session || fetchedRef.current) return;
    fetchedRef.current = true;

    (async () => {
      try {
        // 1. Scan PA flows for third-party connector dependencies.
        const flowConnectors = await fetchThirdPartyConnectors(session);

        // 2. Scan knowledge sources for connectors (e.g. Confluence) using the
        //    agents selected on the SelectData step (stored in sessionStorage).
        let knowledgeConnectors: DetectedConnector[] = [];
        try {
          const agentSelection: Array<{ env: string; botIds: string[] }> =
            JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
          const ksPromises = agentSelection
            .filter((sel) => sel.botIds.length > 0)
            .map((sel) => fetchKnowledgeSourceConnectors(session, sel.env, sel.botIds));
          const ksResults = await Promise.all(ksPromises);
          // Merge: sum flowCount across environments, deduplicate by connectorId.
          const merged = new Map<string, DetectedConnector>();
          for (const list of ksResults) {
            for (const c of list) {
              const existing = merged.get(c.connectorId);
              if (existing) {
                merged.set(c.connectorId, {
                  ...existing,
                  flowCount: existing.flowCount + c.flowCount,
                  flowNames: [...new Set([...existing.flowNames, ...c.flowNames])],
                });
              } else {
                merged.set(c.connectorId, c);
              }
            }
          }
          knowledgeConnectors = [...merged.values()];
        } catch {
          // non-fatal — flow connectors still shown
        }

        // Merge flow + knowledge connectors (deduplicate by connectorId).
        const allById = new Map<string, DetectedConnector>();
        for (const c of [...flowConnectors, ...knowledgeConnectors]) {
          const existing = allById.get(c.connectorId);
          if (existing) {
            allById.set(c.connectorId, {
              ...existing,
              flowCount: existing.flowCount + c.flowCount,
              flowNames: [...new Set([...existing.flowNames, ...c.flowNames])],
            });
          } else {
            allById.set(c.connectorId, c);
          }
        }
        const all = [...allById.values()];

        const ms = all.filter((c) => MS_NATIVE_IDS.has(c.connectorId)).map((c) => c.connectorId);
        const thirdParty = all.filter((c) => !MS_NATIVE_IDS.has(c.connectorId));
        setMsIds(ms);
        setConnectors(thirdParty);

        // Which of these did this customer already configure? Best-effort: if the
        // lookup fails (e.g. Mongo down) every card just asks for credentials
        // again, which is annoying but never wrong.
        try {
          const previously = await fetchSavedConnectors(session);
          setSavedIds(new Set(previously.map((s) => s.connectorId)));
        } catch {
          /* leave empty — cards fall back to asking */
        }
        setLoading(false);
      } catch {
        setError('Could not scan for connector dependencies. Make sure Microsoft is connected.');
        setLoading(false);
      }
    })();
  }, [session]);

  const totalFound = connectors.length + msIds.length;

  return (
    <div className="card wide">
      <div className="step-head">
        <h2>Connector Credentials</h2>
        <p className="lead">
          Your agents connect to external services via Power Automate flows.
          Enter API credentials so the migrated Gemini agents can call them directly.
          Credentials are stored securely in Google Secret Manager — never in logs.
        </p>
      </div>

      {loading && <p className="lead" style={{ color: 'var(--muted)' }}>Scanning flows for connector dependencies…</p>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && totalFound === 0 && (
        <div className="infobox">
          No third-party connector dependencies detected. Your agents use only
          built-in Microsoft services or don't call external APIs via Power Automate.
        </div>
      )}

      {!loading && totalFound > 0 && (
        <div style={{ marginBottom: 8 }}>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
            {totalFound} connector{totalFound !== 1 ? 's' : ''} detected.
            Skip any connector to flag it for manual review in the migration report.
          </p>

          {/* MS native: one shared App Registration card for all MS connectors */}
          <MsNativeSection session={session} detectedMsIds={msIds} />

          {/* Third-party: one card per connector */}
          {connectors.map((c) => (
            <ConnectorCard key={c.connectorId} c={c} session={session} alreadySaved={savedIds.has(c.connectorId)} />
          ))}
        </div>
      )}

      <div className="wizard-actions" style={{ marginTop: 20 }}>
        <button className="wbtn" onClick={() => navigate(`/select-data?session=${session}`)}>← Back</button>
        <button className="wbtn primary" onClick={() => navigate(`/connectors?session=${session}`)}>Continue →</button>
      </div>
    </div>
  );
}
