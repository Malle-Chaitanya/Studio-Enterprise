import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchThirdPartyConnectors,
  fetchKnowledgeSourceConnectors,
  saveConnectorCredentials,
  saveMsConnectorCredentials,
  fetchSavedConnectors,
  fetchConnectorRequirements,
  fetchConnectorsNeeded,
  type DetectedConnector,
  type ConnectorDef,
  type ConnectorRequirement,
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

function MsNativeSection({ session, detectedMsIds, reqs }: {
  session: string;
  detectedMsIds: string[];
  /** Per-connector requirements, so the card can list the exact Graph permissions. */
  reqs?: Map<string, ConnectorRequirement>;
}) {
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
    } catch (err) {
      // Show the server's real cause — usually a missing IAM grant, with the exact
      // command in the message. The old canned line named the wrong culprit.
      setError((err as Error).message || 'Failed to save. Please try again.');
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
          {/* One app, but each connector needs its own permissions added to it. */}
          {detectedMsIds.map((id) => {
            const r = reqs?.get(id);
            if (!r?.requiredPermissions?.length) return null;
            return (
              <div key={id} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  {MS_CONNECTOR_LABELS[id]?.name ?? id} needs:
                </div>
                <PermissionsPanel req={r} />
              </div>
            );
          })}
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

/**
 * The permissions this connector needs on the app whose credentials are being entered.
 *
 * Granting a credential is not granting access: a Microsoft client_credentials exchange
 * returns a token even when nothing has been consented, so without this panel a customer
 * saves credentials, sees a green tick, and discovers the gap only when a migrated agent
 * gets a 403 mid-conversation.
 */
function PermissionsPanel({ req }: { req?: ConnectorRequirement }) {
  if (!req?.requiredPermissions?.length) return null;
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        Permissions to grant{req.adminConsentRequired ? ' (admin consent required)' : ''}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
        {req.requiredPermissions.map((p) => (
          <li key={p}><code style={{ fontSize: 11 }}>{p}</code></li>
        ))}
      </ul>
      {req.adminConsentRequired && (
        <div style={{ fontSize: 11, color: '#b45309', marginTop: 6 }}>
          Add these as <strong>Application</strong> permissions (not Delegated — there is no
          signed-in user when an agent calls the API), then click <strong>Grant admin consent</strong>.
        </div>
      )}
      {req.permissionsHint && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{req.permissionsHint}</div>
      )}
      {req.credentialAlreadySupplied && !req.configured && (
        <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 6 }}>
          ✓ Credentials already provided for {req.group?.name ?? 'this group'} — only the permissions above are needed.
        </div>
      )}
    </div>
  );
}

/**
 * The specific operations the source agent invokes on this connector.
 *
 * Shown because "this agent uses Jira" is not enough for an admin to judge what the
 * migrated agent has to be able to do — Jira exposes dozens of operations and an
 * agent picks a handful. These come from `operationId` on the Copilot Studio action.
 */
function OperationList({ operations }: { operations?: string[] }) {
  if (!operations?.length) return null;
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
      Operations used:{' '}
      {operations.map((op) => (
        <code
          key={op}
          style={{
            display: 'inline-block', background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '1px 6px', marginRight: 4, marginBottom: 4, fontSize: 11,
          }}
        >
          {op}
        </code>
      ))}
    </div>
  );
}

interface ConnectorCardProps {
  /** Narrowed at the call site: an unsupported connector has no def and gets its own
   *  card, so nothing inside here has to guard against a missing registry entry. */
  c: DetectedConnector & { def: ConnectorDef };
  session: string;
  /** Already configured in a previous session — credentials are in Secret Manager. */
  alreadySaved?: boolean;
  /** Fields, permissions and credential-group state from the server. */
  req?: ConnectorRequirement;
}

function ConnectorCard({ c, session, alreadySaved, req }: ConnectorCardProps) {
  const { def, flowCount, flowNames } = c;
  // `def.credentials` holds only the fields a connector declares FOR ITSELF. Connectors in
  // a credential group declare none — Confluence and Jira both leave it empty because
  // base_url/email/api_token belong to the shared `atlassian` group. Rendering from it
  // therefore drew no inputs at all, `[].every()` returned true so Save stayed enabled,
  // and the save posted an empty creds array that the server rejected with
  // `connector_id_and_creds_required`. The server already computes the full list
  // (group + own) and returns it as `req.fields`; use that whenever it is available.
  const fields = req?.fields?.length ? req.fields : def.credentials;
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // Start "saved" when this customer configured the connector before, so a
  // returning admin is not asked to re-enter credentials that already exist in
  // Secret Manager. Values are never sent back to the browser — only the fact.
  const [saved, setSaved] = useState(!!alreadySaved);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState('');
  const [showHint, setShowHint] = useState<string | null>(null);

  // An empty field list must never count as "all filled" — that vacuous `true` is what
  // let the button submit nothing. No fields means we do not yet know what to ask for.
  const allFilled = fields.length > 0 && fields.every((f) => values[f.key]?.trim());

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      await saveConnectorCredentials(session, c.connectorId, fields.map((f) => ({ field: f.key, value: values[f.key] })));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message || 'Failed to save. Please try again.');
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
        {c.confidence === 'heuristic' && !saved && (
          <span
            title="Copilot Studio stores this as a generic federated source, so we inferred the product from its text. Skip it if this agent does not actually use it."
            style={{ fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef3c7', borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}
          >
            LIKELY
          </span>
        )}
        {saved && <span style={{ color: 'var(--ok)', fontSize: 13, fontWeight: 600 }}>✓ Saved</span>}
        {skipped && <span style={{ color: '#f59e0b', fontSize: 13, fontWeight: 600 }}>⚠ Skipped</span>}
      </div>

      {(c.agentNames?.length ?? 0) > 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          Needed by: <strong>{c.agentNames!.join(', ')}</strong>
        </div>
      )}
      <OperationList operations={c.operations} />
      {c.confidence === 'heuristic' && !saved && (
        <div style={{ fontSize: 11, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
          Copilot Studio records this as a generic federated knowledge source — it does not
          name the product. We inferred <strong>{c.def.name}</strong> from the source text.
          If that is wrong, skip it and it will be flagged for review instead.
        </div>
      )}
      {!saved && !skipped && (
        <>
          <PermissionsPanel req={req} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {fields.length === 0 && (
              <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 10px' }}>
                Still loading what this connector needs. If this persists, the credential
                requirements could not be read from the server — skip it and it will be
                flagged for review rather than saved empty.
              </div>
            )}
            {fields.map((field) => (
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
          onClick={() => { setSaved(false); setValues({}); }}>
          Edit
        </button>
      )}
    </div>
  );
}

/**
 * A connector found in a Power Automate flow that we have no way to call.
 *
 * These used to be dropped by the scan, which meant the customer got a clean-looking
 * report that silently omitted a dependency their agent actually relies on. Showing it
 * is the honest behaviour even though there is nothing to configure.
 */
function UnsupportedConnectorCard({ c }: { c: DetectedConnector }) {
  return (
    <div className="card" style={{ padding: '14px 18px', marginBottom: 12, borderStyle: 'dashed' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>⚠️</span>
        <div style={{ flex: 1 }}>
          <strong style={{ fontSize: 14 }}>{c.connectorId}</strong>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
            Used by {c.flowCount} flow{c.flowCount !== 1 ? 's' : ''}
            {c.flowNames.length ? `: ${c.flowNames.slice(0, 3).join(', ')}` : ''}
          </div>
          {(c.agentNames?.length ?? 0) > 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
              Used by agent: <strong>{c.agentNames!.join(', ')}</strong>
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            <OperationList operations={c.operations} />
          </div>
          <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>
            Not supported yet — this connector has no entry in our registry, so the migrated
            agent will not be able to call it. It is recorded in the migration report as a gap.
          </div>
        </div>
      </div>
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
  const [requirements, setRequirements] = useState<Map<string, ConnectorRequirement>>(new Map());
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
        // Hoisted: the agents chosen on SelectData drive BOTH the knowledge-connector
        // scan below and the SharePoint-as-knowledge detection further down.
        let agentSelection: Array<{ env: string; botIds: string[] }> = [];
        try {
          agentSelection = JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
        } catch {
          /* no selection recorded — fall back to scanning nothing extra */
        }

        let knowledgeConnectors: DetectedConnector[] = [];
        try {
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

        // SharePoint/OneDrive used as a KNOWLEDGE source needs the same Azure app as the
        // action connectors — the migrator crawls it through Microsoft Graph and the
        // live tools call Graph at runtime. Detection above only covers Power Automate
        // connectors, so an agent whose SharePoint is knowledge-only reached this step
        // with nothing to fill in and no way to supply credentials.
        let knowledgeMsIds: string[] = [];
        try {
          const needed = await fetchConnectorsNeeded(session, agentSelection[0]?.env ?? '');
          if (needed.some((n) => n.kind === 'sharepoint-connector')) knowledgeMsIds.push('shared_sharepointonline');
          if (needed.some((n) => n.kind === 'onedrive-connector')) knowledgeMsIds.push('shared_onedrive');
        } catch {
          /* detection is best-effort; the cards below still render what we did find */
        }

        const ms = [
          ...new Set([
            ...all.filter((c) => MS_NATIVE_IDS.has(c.connectorId)).map((c) => c.connectorId),
            ...knowledgeMsIds,
          ]),
        ];
        const thirdParty = all.filter((c) => !MS_NATIVE_IDS.has(c.connectorId));
        setMsIds(ms);
        setConnectors(thirdParty);

        // Which of these did this customer already configure? Best-effort: if the
        // lookup fails (e.g. Mongo down) every card just asks for credentials
        // again, which is annoying but never wrong.
        try {
          const previously = await fetchSavedConnectors(session);
          // Only count credentials stored in the project this migration targets.
          // Secrets saved against a different project cannot be read by the deployed
          // agent, so showing them as configured hides a guaranteed failure.
          setSavedIds(new Set(previously.filter((s) => s.matchesDestination !== false).map((s) => s.connectorId)));
        } catch {
          /* leave empty — cards fall back to asking */
        }
        // Permissions + credential-group state. Best-effort: without it the cards still
        // collect credentials, they just cannot warn about permissions.
        try {
          const reqs = await fetchConnectorRequirements(session, [...new Set([...all.map((c) => c.connectorId), ...ms])]);
          setRequirements(new Map(reqs.map((r) => [r.connectorId, r])));
        } catch {
          /* no permission guidance available */
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

      {loading && (
        <>
          <p className="lead" style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="cf-spinner" aria-hidden="true" />
            Scanning your selected agents for connectors…
          </p>
          {/* Skeleton cards — this scan reads each agent's components from Dataverse and
              can take a while; an empty page reads as "nothing needed". */}
          {[0, 1].map((i) => (
            <div key={i} className="card" style={{ padding: '18px 20px', marginBottom: 12, opacity: 1 - i * 0.3 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
                <div className="cf-skel" style={{ width: 26, height: 26, borderRadius: 6 }} />
                <div className="cf-skel" style={{ width: '30%', height: 14 }} />
              </div>
              <div className="cf-skel" style={{ width: '55%', height: 11, marginBottom: 8 }} />
              <div className="cf-skel" style={{ width: '100%', height: 34, borderRadius: 6 }} />
            </div>
          ))}
        </>
      )}
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
          <MsNativeSection session={session} detectedMsIds={msIds} reqs={requirements} />

          {/* Third-party: one card per connector we can actually call */}
          {connectors
            .filter((c): c is DetectedConnector & { def: ConnectorDef } => !!c.def && !c.unsupported)
            .map((c) => (
              <ConnectorCard
                key={c.connectorId}
                c={c}
                session={session}
                alreadySaved={savedIds.has(c.connectorId)}
                req={requirements.get(c.connectorId)}
              />
            ))}

          {/* Detected but not callable — shown, never hidden */}
          {connectors
            .filter((c) => c.unsupported || !c.def)
            .map((c) => (
              <UnsupportedConnectorCard key={c.connectorId} c={c} />
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
