import { useEffect, useRef, useState } from 'react';
import { SurfaceEquivalenceChoice } from '../components/SurfaceEquivalenceChoice';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchThirdPartyConnectors,
  fetchKnowledgeSourceConnectors,
  fetchConnectorsNeeded,
  saveConnectorCredentials,
  saveMsConnectorCredentials,
  fetchSavedConnectors,
  fetchConnectorRequirements,
  fetchCustomConnectors,
  type CustomConnectorInfo,
  fetchAgents,
  fetchSelection,
  fetchCredentialValue,
  fetchDriveIdentities,
  saveDriveIdentity,
  type DetectedConnector,
  type ConnectorDef,
  type ConnectorRequirement,
  type ConnectorValidation,
  type ConnectorReadiness,
  type DriveIdentityStatus,
} from '../api.ts';

/** Merge per-environment scan results into one list, summing flowCount and
 *  de-duplicating flowNames for connectors detected in more than one environment. */
function mergeDetectedConnectors(perEnvResults: DetectedConnector[][]): DetectedConnector[] {
  const merged = new Map<string, DetectedConnector>();
  for (const list of perEnvResults) {
    for (const c of list) {
      const existing = merged.get(c.connectorId);
      merged.set(c.connectorId, existing
        ? { ...existing, flowCount: existing.flowCount + c.flowCount, flowNames: [...new Set([...existing.flowNames, ...c.flowNames])] }
        : c);
    }
  }
  return [...merged.values()];
}

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
  { key: 'tenant_id',     label: 'Tenant ID',      type: 'password' as const, hint: 'Azure Portal → Azure Active Directory → Properties → Directory (tenant) ID' },
  { key: 'client_id',     label: 'App (Client) ID', type: 'password' as const, hint: 'Azure Portal → App registrations → your app → Application (client) ID' },
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
  // Entra hands out a valid token for an app with nothing consented, so a successful
  // save says nothing about whether Graph calls will work. This holds the live check.
  const [validation, setValidation] = useState<ConnectorValidation | null>(null);
  // Fields the admin has explicitly chosen to overwrite, and which password inputs are
  // currently revealed. Both mirror the generic connector card, which already had them —
  // this section did not, which is why Microsoft asked for all three credentials on every
  // visit while HubSpot, Jira, Confluence and Drive stayed saved.
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [msExpanded, setMsExpanded] = useState(false);
  // Stored values the admin has asked to see. Fetched one field at a time, on click — a
  // credential is never part of a page load, so walking past this screen does not put a
  // client secret in a response.
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const reveal = async (fieldKey: string) => {
    if (revealedValues[fieldKey]) {
      setRevealedValues((r) => { const next = { ...r }; delete next[fieldKey]; return next; });
      return;
    }
    try {
      const value = await fetchCredentialValue(session, detectedMsIds[0], fieldKey);
      setRevealedValues((r) => ({ ...r, [fieldKey]: value }));
    } catch {
      setRevealedValues((r) => ({ ...r, [fieldKey]: '(could not read)' }));
    }
  };

  if (detectedMsIds.length === 0) return null;

  // A connector in the ms_graph group can still declare fields of its OWN on top of the
  // shared 3 (e.g. Dynamics 365 needs org_url — see registry.ts's credentialGroup doc
  // comment). Those never belonged to the shared Azure app, so they must be collected
  // per-connector and saved to that connector's own scope, not the shared one — otherwise
  // they were never asked for anywhere and the connector's base URL template is left with
  // a literal unresolved "{org_url}" at runtime.
  const ownFieldsById = new Map(
    detectedMsIds
      .map((id) => [id, (reqs?.get(id)?.fields ?? []).filter((f) => !f.shared)] as const)
      .filter(([, fields]) => fields.length > 0),
  );
  const ownValueKey = (id: string, fieldKey: string) => `${id}::${fieldKey}`;

  // Which shared fields Secret Manager already holds. Every ms_graph connector reports the
  // same shared credential state, so the first detected one answers for all of them.
  const sharedSupplied = new Set(
    detectedMsIds
      .flatMap((id) => reqs?.get(id)?.fields ?? [])
      .filter((f) => f.shared !== false && f.supplied)
      .map((f) => f.key),
  );
  const needsValue = (key: string, supplied: boolean) => !supplied || replacing[key];
  const alreadyConfigured = MS_NATIVE_FIELDS.every((f) => sharedSupplied.has(f.key));

  // A field already in Secret Manager is satisfied without input. Only what is being
  // entered — or deliberately replaced — has to be filled, so a returning admin can press
  // Save without retyping a client secret the product already has. Each retype also wrote
  // another identical secret version, which is the cost this avoids.
  const allFilled =
    MS_NATIVE_FIELDS.every((f) =>
      needsValue(f.key, sharedSupplied.has(f.key)) ? !!values[f.key]?.trim() : true,
    ) &&
    [...ownFieldsById.entries()].every(([id, fields]) =>
      fields.every((f) =>
        needsValue(ownValueKey(id, f.key), !!f.supplied) ? !!values[ownValueKey(id, f.key)]?.trim() : true,
      ),
    );

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      // Send only what the admin actually typed. The server merges onto the stored record
      // and skips writing a new secret version for an unchanged value, so omitting an
      // untouched field leaves both the secret and its id exactly as they are — which
      // matters because deployed agents resolve credentials by that id.
      const typed = Object.fromEntries(
        MS_NATIVE_FIELDS.filter((f) => needsValue(f.key, sharedSupplied.has(f.key)) && values[f.key]?.trim())
          .map((f) => [f.key, values[f.key]]),
      );
      const { validation: v } = await saveMsConnectorCredentials(session, typed);
      setValidation(v ?? null);
      // Connector-OWN fields (e.g. Dynamics `org_url`) are not part of the shared
      // ms_graph credential and are saved separately — the group save above does not
      // carry them.
      for (const [id, fields] of ownFieldsById) {
        await saveConnectorCredentials(
          session,
          id,
          fields.map((f) => ({ field: f.key, value: values[ownValueKey(id, f.key)] })),
        );
      }
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
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
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
        </div>
        {/* `alreadyConfigured` covers the RETURNING admin: the credentials are in Secret
            Manager from an earlier visit, so the card must read as done on arrival rather
            than as an untouched form demanding three values. */}
        {(saved || alreadyConfigured) && (
          <span style={{
            color: !validation || validation.code === 'ok' || validation.code === 'unverified' ? 'var(--ok)' : '#dc2626',
            fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
          }}>
            {!validation ? '✓ Saved' : validation.code === 'ok' ? '✓ Verified' : validation.code === 'unverified' ? '✓ Saved' : '⚠ Saved, but not working'}
          </span>
        )}
      </div>
      {/* Flush-left with the rest of the card body (needs/permissions/inputs below) —
          not indented under the icon, so the left edge stays consistent top to bottom. */}
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0, marginBottom: 12 }}>
        Create one <strong>app registration</strong> in Azure and give it the permissions listed
        below. Your new Gemini agents will use it to securely access Microsoft data like
        SharePoint and Teams.
      </p>

      {saved && validation && validation.code !== 'ok' && validation.code !== 'unverified' && validation.detail && (
        <div style={{
          fontSize: 12, marginBottom: 10, padding: '8px 10px', borderRadius: 6,
          color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca',
        }}>
          {validation.detail}
          {validation.grantedPermissions && (
            <div style={{ marginTop: 4 }}>
              Consented today: {validation.grantedPermissions.length ? validation.grantedPermissions.join(', ') : 'none'}.
            </div>
          )}
        </div>
      )}

      {/* A configured Azure app has nothing left to do on this screen, and it is the widest
          block on the page — one shared form plus a permissions checklist per Microsoft
          connector detected. Collapsed to the badge above until the admin asks to change it. */}
      {alreadyConfigured && !saved && !msExpanded && (
        <button
          type="button"
          onClick={() => setMsExpanded(true)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--brand)', fontSize: 12 }}
        >Change credentials or review permissions</button>
      )}

      {!saved && (!alreadyConfigured || msExpanded) && (
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
                {!needsValue(field.key, sharedSupplied.has(field.key)) ? (
                  // Already in Secret Manager. Shown as satisfied rather than as an empty
                  // required input. Reveal fetches the stored value on demand (one field per
                  // request) — it is never included in a page load.
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                    <span style={{ color: 'var(--ok)', fontWeight: 600 }}>✓ Saved</span>
                    <span style={{ color: 'var(--muted)', letterSpacing: revealedValues[field.key] ? 0 : 2, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                      {revealedValues[field.key] ?? '••••••••••••'}
                    </span>
                    <button
                      type="button"
                      title={revealedValues[field.key] ? 'Hide' : 'Show the stored value'}
                      onClick={() => reveal(field.key)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: 0 }}
                    >{revealedValues[field.key] ? '🙈' : '👁'}</button>
                    <button
                      type="button"
                      onClick={async () => {
                        // Prefill with the stored value so the admin edits what is there
                        // instead of retyping a 40-character secret from scratch.
                        const current = revealedValues[field.key] ?? (await fetchCredentialValue(session, detectedMsIds[0], field.key).catch(() => ''));
                        setValues((v) => ({ ...v, [field.key]: current }));
                        setReplacing((r) => ({ ...r, [field.key]: true }));
                      }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand)', fontSize: 12, padding: 0 }}
                    >Replace</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type={field.type === 'password' && !revealed[field.key] ? 'password' : 'text'}
                      value={values[field.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    {field.type === 'password' && (
                      // Reveals only what the admin is typing right now, so a mistyped
                      // secret is caught before saving. It can never show a stored value.
                      <button
                        type="button"
                        title={revealed[field.key] ? 'Hide' : 'Show what you typed'}
                        onClick={() => setRevealed((r) => ({ ...r, [field.key]: !r[field.key] }))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
                      >{revealed[field.key] ? '🙈' : '👁'}</button>
                    )}
                    {sharedSupplied.has(field.key) && (
                      <button
                        type="button"
                        onClick={() => {
                          setReplacing((r) => ({ ...r, [field.key]: false }));
                          setValues((v) => ({ ...v, [field.key]: '' }));
                        }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}
                      >Cancel</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Per-connector own fields on top of the shared app (e.g. Dynamics' org_url) —
              one small sub-block per connector that declares any, right below the shared form. */}
          {[...ownFieldsById.entries()].map(([id, fields]) => (
            <div key={id} style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                {MS_CONNECTOR_LABELS[id]?.name ?? id} also needs:
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {fields.map((field) => (
                  <div key={field.key}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <label style={{ fontSize: 12, fontWeight: 600 }}>{field.label}</label>
                      {field.hint && (
                        <button
                          type="button"
                          onClick={() => setShowHint(showHint === ownValueKey(id, field.key) ? null : ownValueKey(id, field.key))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 13, padding: 0 }}
                        >ⓘ</button>
                      )}
                    </div>
                    {showHint === ownValueKey(id, field.key) && field.hint && (
                      <div style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', marginBottom: 6 }}>
                        {field.hint}
                      </div>
                    )}
                    <input
                      type={field.type === 'password' ? 'password' : 'text'}
                      value={values[ownValueKey(id, field.key)] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [ownValueKey(id, field.key)]: e.target.value }))}
                      placeholder={field.placeholder ?? ''}
                      style={inputStyle}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

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
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}

      {saved && (
        <button className="wbtn" style={{ fontSize: 11, padding: '4px 12px', marginTop: 6 }}
          onClick={() => {
            setSaved(false);
            // Never let a typed client_secret linger in state longer than needed —
            // same posture as ConnectorSetup.tsx's SharePoint form.
            setValues({ tenant_id: '', client_id: '', client_secret: '' });
          }}>
          Edit
        </button>
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
/**
 * A one-line summary that opens to the detail underneath.
 *
 * This screen had grown to stack a permissions checklist, a full operation list and a
 * readiness breakdown under EVERY connector, all expanded, all at once. Each block earned
 * its place once — during first-time Azure setup, or when judging what an agent does — and
 * then stayed on screen for every visit afterwards, which is what made the page unreadable.
 * Collapsed by default keeps the information (nothing here is deleted) while letting the
 * customer see the whole connector list at a glance.
 */
function Disclosure({ summary, children, defaultOpen = false }: {
  summary: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5,
        }}
      >
        <span style={{ fontSize: 9 }}>{open ? '▼' : '▶'}</span>
        {summary}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

function PermissionsPanel({ req }: { req?: ConnectorRequirement }) {
  if (!req?.requiredPermissions?.length) return null;
  const n = req.requiredPermissions.length;
  // Collapsed by default: this is a checklist for ONE Azure setup visit, not standing
  // reference. Left open on an unconfigured connector whose consent is still needed,
  // because that admin has not done the setup yet and the list is the whole task.
  return (
    <Disclosure
      defaultOpen={!req.configured && !!req.adminConsentRequired}
      summary={`${n} permission${n === 1 ? '' : 's'} to grant${req.adminConsentRequired ? ' (admin consent required)' : ''}`}
    >
    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', marginBottom: 12 }}>
      {/* Plain stacked lines, not a bulleted <ul> — list-style-position: inside
          pushed the marker+text a few px right of "Permissions to grant" and the
          note below it, so the left edges inside the box didn't line up. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        {req.requiredPermissions.map((p) => (
          <code key={p} style={{ fontSize: 11 }}>{p}</code>
        ))}
      </div>
      {req.adminConsentRequired && (
        <div style={{ fontSize: 11, color: '#b45309', marginTop: 6 }}>
          In Azure, add these under <strong>Application permissions</strong> — not
          <strong> Delegated</strong>, since the agent runs on its own with no one signed in.
          Then click <strong>Grant admin consent</strong>.
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
    </Disclosure>
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
  // The COUNT is the part an admin acts on at a glance ("this agent touches 4 Jira calls");
  // the individual operationIds matter only when judging a specific behaviour, so they move
  // behind the toggle rather than off the page.
  return (
    <Disclosure summary={`${operations.length} operation${operations.length === 1 ? '' : 's'} used`}>
    <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
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
    </Disclosure>
  );
}

/**
 * Warns about connectors with NO working fallback at all.
 *
 * "Blocked" (readiness.blocked) means one narrow thing: an operation can't be
 * replayed with the EXACT arguments the source agent had baked in. That is not the
 * same as the capability being gone — every connector WITH a def gets a real,
 * general-purpose live tool wired regardless (connectorToolBuilder.ts's
 * buildLiveConnectorSpecsDetailed runs unconditionally for any registered
 * connector). Google Drive is the clearest case: 0 of its operations bind to an
 * exact call, and the live tool still fully works — live-verified against real
 * Drive data, 2026-08-13. Listing 11 near-identical "can't do an exact replay"
 * lines on the credential screen read as "broken" for something that works, and
 * wasn't acting on anything the admin could do differently here — that detail
 * still reaches the customer in the post-migration fidelity report as a `partial`
 * note (orchestrator.ts), it just does not belong on THIS screen. So this only
 * renders for connectors with NO def at all (hasLiveTool=false,
 * UnsupportedConnectorCard) — the one real case where there is nothing to fall
 * back on and the admin needs to know before saving anything.
 */
function ReadinessPanel({ readiness, hasLiveTool = true }: { readiness?: ConnectorReadiness; hasLiveTool?: boolean }) {
  if (hasLiveTool || !readiness) return null;
  const total = readiness.bindable.length + readiness.blocked.length;
  if (total === 0) return null;
  const ok = readiness.ready;
  // One line, then the per-operation reasons behind a toggle. This only ever renders for a
  // connector with NO live tool at all, so the verdict IS the actionable part; the blocked
  // list explains it and is worth keeping, just not worth stacking on arrival.
  return (
    <div style={{
      fontSize: 12, borderRadius: 6, padding: '8px 10px', marginBottom: 10,
      background: ok ? '#f0fdf4' : '#fffbeb',
      border: `1px solid ${ok ? '#bbf7d0' : '#fde68a'}`,
      color: ok ? '#166534' : '#92400e',
    }}>
      <strong>
        {ok
          ? total === 1
            ? `The one operation this agent uses maps to ${readiness.displayName}'s own API.`
            : `All ${total} operations map to ${readiness.displayName}'s own API.`
          : `${readiness.bindable.length} of ${total} operations map to ${readiness.displayName}'s own API.`}
      </strong>
      {readiness.blocked.length > 0 && (
        <Disclosure summary={`Why ${readiness.blocked.length} cannot`}>
          {readiness.blocked.map((b) => (
            <div key={b.operationId} style={{ marginTop: 6 }}>
              <code style={{ fontSize: 11 }}>{b.operationId}</code> — {b.reason}
            </div>
          ))}
        </Disclosure>
      )}
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
  /** Fires once, right after a FRESH save succeeds (never on load from alreadySaved) —
   *  lets the parent chain a follow-up step (e.g. Google Drive's per-agent identity
   *  popup) onto the moment credentials actually just got entered. */
  onSaved?: () => void;
}

function ConnectorCard({ c, session, alreadySaved, req, onSaved }: ConnectorCardProps) {
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

  // Fields the admin has explicitly chosen to overwrite. A field whose value already
  // exists in Secret Manager is shown as satisfied rather than as an empty required
  // input — asking again made admins retype credentials the product already had, and
  // every retype wrote another version of an identical secret.
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  // Outcome of the live check the server runs after storing. Kept separate from `error`:
  // the credential IS saved, so this is a warning about whether it works, not a failure
  // to save. Showing "✓ Saved" alone is what let a broken connector reach a customer.
  const [validation, setValidation] = useState<ConnectorValidation | null>(null);
  // A configured connector collapses to a single line. Nothing on an already-saved card is
  // actionable — the permissions were granted, the operations were reviewed, the credential
  // is in Secret Manager — so a fully-set-up tenant was rendering a screenful of finished
  // work above the one connector that still needed attention. Expand restores the full card.
  const [expanded, setExpanded] = useState(false);
  // Stored values the admin asked to see, and which inputs are unmasked. Both are per-field
  // and fetched on click — never on page load.
  const [stored, setStored] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const needsValue = (f: { key: string; supplied?: boolean }) => !f.supplied || replacing[f.key];

  // An empty field list must never count as "all filled" — that vacuous `true` is what
  // let the button submit nothing. No fields means we do not yet know what to ask for.
  // Fields already supplied are satisfied without input; only the ones being entered
  // or deliberately replaced have to be filled.
  const allFilled =
    fields.length > 0 && fields.every((f) => (needsValue(f) ? !!values[f.key]?.trim() : true));

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      // Send only what the admin actually typed. The server merges onto the existing
      // record and skips writing a new secret version when the value is unchanged, so
      // omitting an untouched field leaves both the secret and its id exactly as they
      // are — which matters because deployed agents resolve credentials by that id.
      const changed = fields
        .filter((f) => needsValue(f) && values[f.key]?.trim())
        .map((f) => ({ field: f.key, value: values[f.key] }));
      // An empty list is still sent: the server registers the connector against the
      // credentials a sibling already supplied, and runs the same live check.
      const { validation: v } = await saveConnectorCredentials(session, c.connectorId, changed);
      setValidation(v ?? null);
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError((err as Error).message || 'Failed to save. Please try again.');
    } finally { setSaving(false); }
  };

  // A finished connector, rendered as one line. It still reports whether the live check
  // PASSED, because "saved" and "working" are different facts and collapsing must not blur
  // them — a credential that stored fine but failed validation stays visibly wrong here.
  if (saved && !expanded && !skipped) {
    const bad = validation && validation.code !== 'ok' && validation.code !== 'unverified';
    return (
      <div
        className="card"
        style={{ padding: '10px 16px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}
      >
        <span style={{ fontSize: 16 }}>{def.icon}</span>
        <strong style={{ fontSize: 13, flex: 1 }}>{def.name}</strong>
        <span style={{ fontSize: 12, fontWeight: 600, color: bad ? '#dc2626' : 'var(--ok)', whiteSpace: 'nowrap' }}>
          {bad ? 'Saved, but not working' : 'Saved'}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand)', fontSize: 12, padding: 0 }}
        >Edit</button>
      </div>
    );
  }

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
            {saved && expanded && (
              // Way back to the one-line form. Without it, opening a finished connector to
              // check something left the page permanently more crowded than before.
              <button
                type="button"
                onClick={() => setExpanded(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, padding: 0 }}
              >collapse</button>
            )}
          </div>
          {c.connectorId === 'shared_confluence' && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              <span>
                {flowCount} knowledge source{flowCount !== 1 ? 's' : ''}
                {flowNames.length > 0 && (
                  <span title={flowNames.join(', ')}>
                    {' '}· {flowNames.slice(0, 2).join(', ')}{flowNames.length > 2 ? ` +${flowNames.length - 2} more` : ''}
                  </span>
                )}
                {' '}— Confluence spaces will be crawled and indexed for this agent.
              </span>
            </div>
          )}
          {/* Every other connector: the flow-name preview line ("N flows · op1, op2 +N
              more") duplicated what OperationList already shows in full right below —
              redundant, and the truncated "+N more" read as clumsy rather than useful. */}
        </div>
        {c.confidence === 'heuristic' && !saved && (
          <span
            title="Copilot Studio doesn't say exactly which service this is, so we guessed from the description. Skip it if this agent doesn't actually use it."
            style={{ fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef3c7', borderRadius: 4, padding: '2px 6px', whiteSpace: 'nowrap' }}
          >
            LIKELY
          </span>
        )}
        {/* "Saved" only claims storage. Whether it WORKS is the validation badge — a
            credential that stored fine and cannot call the API is the failure this
            screen exists to catch, so it must not read as a plain success. */}
        {saved && validation?.code === 'ok' && (
          <span style={{ color: 'var(--ok)', fontSize: 13, fontWeight: 600 }}>✓ Verified</span>
        )}
        {saved && validation && validation.code !== 'ok' && validation.code !== 'unverified' && (
          <span style={{ color: '#dc2626', fontSize: 13, fontWeight: 600 }}>⚠ Saved, but not working</span>
        )}
        {saved && (!validation || validation.code === 'unverified') && (
          <span style={{ color: 'var(--ok)', fontSize: 13, fontWeight: 600 }}>✓ Saved</span>
        )}
        {skipped && <span style={{ color: '#f59e0b', fontSize: 13, fontWeight: 600 }}>⚠ Skipped</span>}
      </div>

      {saved && validation && validation.code !== 'ok' && validation.code !== 'unverified' && validation.detail && (
        <div style={{
          fontSize: 12, marginBottom: 10, padding: '8px 10px', borderRadius: 6,
          color: '#991b1b', background: '#fef2f2', border: '1px solid #fecaca',
        }}>
          {validation.detail}
          {validation.code === 'permission_denied' && (
            <div style={{ marginTop: 4 }}>
              The credentials themselves are correct — this needs a permission grant, not a new token.
            </div>
          )}
        </div>
      )}

      {(c.agentNames?.length ?? 0) > 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          Needed by: <strong>{c.agentNames!.join(', ')}</strong>
        </div>
      )}
      <OperationList operations={c.operations} />
      <ReadinessPanel readiness={c.readiness} />
      {c.confidence === 'heuristic' && !saved && (
        <div style={{ fontSize: 11, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 10px', marginBottom: 10 }}>
          Copilot Studio doesn't name the exact service here, so we guessed
          <strong> {c.def.name}</strong> from the description. If that's wrong, skip it below
          and we'll flag it for review instead.
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
                {needsValue(field) ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type={field.type === 'password' && !shown[field.key] ? 'password' : 'text'}
                      value={values[field.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                      placeholder={field.placeholder ?? ''}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    {field.type === 'password' && (
                      <button
                        type="button"
                        title={shown[field.key] ? 'Hide' : 'Show'}
                        onClick={() => setShown((r) => ({ ...r, [field.key]: !r[field.key] }))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
                      >{shown[field.key] ? '🙈' : '👁'}</button>
                    )}
                  </div>
                ) : (
                  // Stored. Reveal fetches the value on demand, one field per request, so a
                  // credential is never part of a page load. Replacing is still deliberate:
                  // leaving it alone writes nothing, which is what keeps identical secret
                  // versions from piling up every time this screen is revisited.
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)', padding: '6px 0' }}>
                    <span style={{ color: 'var(--ok)' }}>✓ Already stored</span>
                    <span style={{ fontFamily: 'monospace', letterSpacing: shown[field.key] ? 0 : 2, wordBreak: 'break-all', maxWidth: 320 }}>
                      {stored[field.key] ?? '••••••••••••'}
                    </span>
                    <button
                      type="button"
                      title={stored[field.key] ? 'Hide' : 'Show the stored value'}
                      onClick={async () => {
                        if (stored[field.key]) {
                          setStored((r) => { const n = { ...r }; delete n[field.key]; return n; });
                          setShown((r) => ({ ...r, [field.key]: false }));
                          return;
                        }
                        const v = await fetchCredentialValue(session, c.connectorId, field.key)
                          .catch(() => '(could not read)');
                        setStored((r) => ({ ...r, [field.key]: v }));
                        setShown((r) => ({ ...r, [field.key]: true }));
                      }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, padding: 0 }}
                    >{stored[field.key] ? '🙈' : '👁'}</button>
                    <button type="button" className="wbtn" style={{ fontSize: 11, padding: '2px 10px' }}
                      onClick={async () => {
                        // Prefill so the admin edits what is there rather than retyping it.
                        const current = stored[field.key]
                          ?? (await fetchCredentialValue(session, c.connectorId, field.key).catch(() => ''));
                        setValues((v) => ({ ...v, [field.key]: current }));
                        setReplacing((r) => ({ ...r, [field.key]: true }));
                      }}>
                      Replace
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
            <button className="wbtn primary" style={{ fontSize: 12, padding: '6px 16px' }}
              disabled={saving || !allFilled} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save'}
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
          onClick={() => { setSaved(false); setValues({}); setReplacing({}); }}>
          Edit
        </button>
      )}
    </div>
  );
}

// ── Shared-credential-group card ──────────────────────────────────────────────

interface GroupSectionProps {
  session: string;
  /** Every detected connector in this group (e.g. Confluence + Jira on 'atlassian'). */
  members: (DetectedConnector & { def: ConnectorDef })[];
  reqs: Map<string, ConnectorRequirement>;
}

/**
 * One shared card for connectors whose credentials come from a `credentialGroup`
 * (registry.ts) instead of their own `credentials` list — e.g. Confluence and Jira
 * both read from the single Atlassian API token. `ConnectorCard` renders inputs
 * from `def.credentials`, which the registry deliberately leaves empty for these
 * ("supplied by the credential group") — so without this component the card had
 * nothing to render and looked permanently inert, with no way to enter the
 * Atlassian email/token pair at all.
 *
 * Mirrors `MsNativeSection` below, but driven by whatever `fetchConnectorRequirements`
 * resolves (registry.ts's `connectorCredentialFields`) instead of a hardcoded field
 * list — so any future credential group gets this UI for free, not just Microsoft's.
 *
 * Saves once per detected member (not just the first): the secret VALUE lands in the
 * group's shared Secret Manager scope either way (`connectorSecretId` resolves group
 * fields to the group scope regardless of which connectorId the save call used), but
 * the orchestrator looks up a specific connector's resolved credentials by matching its
 * literal id in `resolvedConnectors` (built only from `session.plan.savedConnectors` —
 * see orchestrator.ts's `confluenceConnector = resolvedConnectors.find(c => c.connectorId
 * === 'shared_confluence')`). Saving only the first member would silently leave a
 * same-group sibling (e.g. Confluence when Jira happened to sort first) out of that
 * list — credentials present in Secret Manager, but never wired into that agent's crawl.
 */
function GroupSection({ session, members, reqs }: GroupSectionProps) {
  const firstReq = reqs.get(members[0].connectorId);
  const group = firstReq?.group;
  // Group-owned fields only (shared: true) — a member's OWN fields (e.g. a future
  // connector with both group creds and its own extra field) still belong on that
  // member's individual ConnectorCard, not duplicated here.
  const fields = (firstReq?.fields ?? []).filter((f) => f.shared);

  const alreadySupplied = members.some((m) => {
    const r = reqs.get(m.connectorId);
    return r?.configured || r?.credentialAlreadySupplied;
  });

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, ''])));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(alreadySupplied);
  const [error, setError] = useState('');
  const [showHint, setShowHint] = useState<string | null>(null);

  if (fields.length === 0) return null; // nothing this group actually needs to ask for

  const allFilled = fields.every((f) => values[f.key]?.trim());

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      // One call per detected member — see the doc comment above for why the first
      // member alone isn't enough (orchestrator matches connectorId literally).
      // Same secret values every time (harmless re-write), but each call records
      // its OWN connectorId onto session.plan.savedConnectors.
      const creds = fields.map((f) => ({ field: f.key, value: values[f.key] }));
      for (const m of members) {
        await saveConnectorCredentials(session, m.connectorId, creds);
      }
      setSaved(true);
    } catch {
      setError('Failed to save. Check Google is connected and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: '18px 20px', marginBottom: 12, opacity: saved ? 0.7 : 1, transition: 'opacity 0.2s' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 22 }}>{members[0].def.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 15 }}>{group?.name ?? members.map((m) => m.def.name).join(' + ')}</strong>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            Used by: {members.map((m) => m.def.name).join(', ')}
            {members.some((m) => (m.agentNames?.length ?? 0) > 0) && (
              <> — {[...new Set(members.flatMap((m) => m.agentNames ?? []))].join(', ')}</>
            )}
          </div>
        </div>
        {saved && <span style={{ color: 'var(--ok)', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>✓ Saved</span>}
      </div>

      {/* What each member can actually DO, shown whether or not credentials are saved.
          Readiness is a statement about the operations, not about the token — hiding it
          behind the unsaved state meant the connectors that share a credential group
          (Atlassian, HubSpot — i.e. most of what we migrate) never showed it at all,
          while a standalone connector did. The customer could not tell that an
          operation was refused until the fidelity report. */}
      {members.map((m) => (
        <div key={m.connectorId}>
          <OperationList operations={m.operations} />
          <ReadinessPanel readiness={m.readiness} />
        </div>
      ))}

      {!saved && (
        <>
          {members.map((m) => (
            <PermissionsPanel key={m.connectorId} req={reqs.get(m.connectorId)} />
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
          {/* Explanatory text on its own line — it used to double as the setupUrl link
              label, which wrapped it across 2-3 lines inside the button row below and
              left Save vertically centered against a paragraph instead of one line. */}
          {group?.setupHint && (
            <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, marginBottom: 0, lineHeight: 1.5 }}>
              {group.setupHint}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
            {group?.setupUrl && (
              <a href={group.setupUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--brand)' }}>
                Get credentials ↗
              </a>
            )}
            <button className="wbtn primary" style={{ fontSize: 12, padding: '6px 16px', marginLeft: 'auto' }}
              disabled={saving || !allFilled} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}

      {saved && (
        <button className="wbtn" style={{ fontSize: 11, padding: '4px 12px', marginTop: 6 }}
          onClick={() => { setSaved(false); setValues(Object.fromEntries(fields.map((f) => [f.key, '']))); }}>
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
          <strong style={{ fontSize: 14 }}>{c.readiness?.displayName ?? c.connectorId}</strong>
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
            <ReadinessPanel readiness={c.readiness} hasLiveTool={false} />
          </div>
          <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>
            We don't support this connector yet, so the new agent won't be able to use it.
            This will show up as a gap in your migration report.
            {c.readiness?.ready && (
              <> Its operations do map cleanly onto {c.readiness.displayName}'s own API, so
              this is a gap on our side rather than a limit of your agent.</>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Per-agent Google Drive identity ───────────────────────────────────────────

interface DriveAgentRow {
  sourceId: string;
  name: string;
}

/**
 * One agent's row: confirm/change which Google account its Drive tool impersonates.
 * Never auto-confirms a suggestion — the admin has to actively click Confirm, even
 * when a suggestion is pre-filled into the input.
 */
function DriveIdentityRow({ session, agent, status, onSaved }: {
  session: string;
  agent: DriveAgentRow;
  status: DriveIdentityStatus | undefined;
  onSaved: (sourceId: string, email: string) => void;
}) {
  const current = status?.current;
  const suggestion = status?.suggestion;
  const confirmed = current?.status === 'confirmed';
  const [editing, setEditing] = useState(!confirmed);
  const [value, setValue] = useState(current?.email ?? suggestion?.email ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const email = value.trim();
    if (!email) return;
    setSaving(true);
    setError('');
    try {
      await saveDriveIdentity(session, agent.sourceId, email);
      onSaved(agent.sourceId, email);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: '0 0 150px', fontSize: 13, fontWeight: 600 }}>{agent.name}</div>
        {!editing ? (
          <>
            <span style={{ fontSize: 12, color: 'var(--ok)' }}>✓ {current!.email}</span>
            <button className="dlink" style={{ marginLeft: 'auto' }} onClick={() => setEditing(true)}>Change</button>
          </>
        ) : (
          <>
            <input
              className="usearch"
              style={{ flex: 1, fontSize: 12, padding: '5px 8px' }}
              placeholder="user@yourcompany.com"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <button className="wbtn primary" style={{ fontSize: 12, padding: '4px 12px' }} disabled={saving || !value.trim()} onClick={save}>
              {saving ? 'Saving…' : 'Confirm'}
            </button>
            {confirmed && (
              <button className="wbtn" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setEditing(false)}>Cancel</button>
            )}
          </>
        )}
      </div>
      {editing && suggestion && !confirmed && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }} title={suggestion.reason}>
          Suggested from a connection reference — confirm it's right before saving.
        </div>
      )}
      {error && <div style={{ fontSize: 11, color: '#dc2626', marginTop: 4 }}>{error}</div>}
    </div>
  );
}

/**
 * Lists every selected agent that uses the shared_googledrive connector and lets the
 * admin confirm/correct WHICH Google account each one should impersonate. Rendered
 * as the body of DriveIdentityModal — one service-account key covers everyone, but
 * WHICH person's Drive an agent uses is a per-agent fact, never assumed.
 */
function DriveIdentitySection({ session, envsWithAgents }: {
  session: string;
  envsWithAgents: Array<{ env: string; botIds: string[] }>;
}) {
  const [rows, setRows] = useState<DriveAgentRow[] | null>(null);
  const [statuses, setStatuses] = useState<Map<string, DriveIdentityStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current || envsWithAgents.length === 0) return;
    fetchedRef.current = true;
    (async () => {
      const allRows: DriveAgentRow[] = [];
      const allStatuses = new Map<string, DriveIdentityStatus>();
      for (const sel of envsWithAgents) {
        try {
          const agents = await fetchAgents(session, sel.env);
          const selected = agents.filter((a) => sel.botIds.includes(a.botid));
          for (const a of selected) allRows.push({ sourceId: a.botid, name: a.name });
          const found = await fetchDriveIdentities(session, sel.env, selected.map((a) => a.botid));
          for (const s of found) allStatuses.set(s.sourceId, s);
        } catch {
          // best-effort per environment — one environment's lookup failing must not
          // blank the whole section; that agent just falls back to an empty input
        }
      }
      setRows(allRows);
      setStatuses(allStatuses);
      setLoading(false);
    })();
  }, [session, envsWithAgents]);

  if (loading) return <p className="ksdetail" style={{ marginTop: 6 }}>Checking which agents need a Google account assigned…</p>;
  if (!rows || rows.length === 0) {
    return <p className="ksdetail" style={{ marginTop: 6 }}>None of the selected agents need a Drive account assigned.</p>;
  }

  const handleSaved = (sourceId: string, email: string) => {
    setStatuses((prev) => {
      const next = new Map(prev);
      next.set(sourceId, { sourceId, current: { email, status: 'confirmed' }, suggestion: null });
      return next;
    });
  };

  return (
    <div>
      {rows.map((r) => (
        <DriveIdentityRow key={r.sourceId} session={session} agent={r} status={statuses.get(r.sourceId)} onSaved={handleSaved} />
      ))}
    </div>
  );
}

/**
 * Popup shown right after the Google Drive service-account key is saved — asks the
 * per-agent "whose Drive" question as a guided follow-up step instead of a permanent
 * card sitting under the credential form. Also reachable any time afterward via the
 * small link ConnectorConfig renders next to the Drive card, since returning admins
 * (or a newly-selected agent) still need a way back in without re-entering the key.
 */
function DriveIdentityModal({ session, envsWithAgents, onClose }: {
  session: string;
  envsWithAgents: Array<{ env: string; botIds: string[] }>;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title" style={{ flex: 1 }}>Whose Drive does each agent use?</div>
          <button
            type="button"
            className="mdelete"
            onClick={onClose}
            aria-label="Close"
            style={{ fontSize: 15, flexShrink: 0 }}
          >
            ✕
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: -8, marginBottom: 14, lineHeight: 1.5 }}>
          One shared key covers every agent below — but each one needs its OWN Google account
          confirmed here, since different agents can belong to different people.
        </p>
        <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
          <DriveIdentitySection session={session} envsWithAgents={envsWithAgents} />
        </div>
        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button type="button" className="wbtn primary" onClick={onClose}>
            Done
          </button>
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
  // The customer's OWN connectors. `listed:false` means we could not read the listing,
  // which is not the same as "none" and is rendered differently.
  const [customConnectors, setCustomConnectors] = useState<{ listed: boolean; connectors: CustomConnectorInfo[] } | null>(null);
  const [requirements, setRequirements] = useState<Map<string, ConnectorRequirement>>(new Map());
  const [error, setError] = useState('');
  const [envsWithAgents, setEnvsWithAgents] = useState<Array<{ env: string; botIds: string[] }>>([]);
  const [showDriveModal, setShowDriveModal] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!session || fetchedRef.current) return;
    fetchedRef.current = true;

    (async () => {
      try {
        // Environments the user actually selected agents from (SelectData) —
        // both scans below run once PER environment and merge, instead of
        // assuming everything lives in one "default" Dataverse org. A tenant
        // can have agents (and their PA flows / knowledge sources) spread
        // across several environments.
        // Which agents this page asks about, and WHY in this order.
        //
        // sessionStorage is the CURRENT selection, written by SelectData one step before
        // this page. The server plan is NOT an alternative source of the same truth: it is
        // written by POST /api/migrate/plan on the *Migrate* step, which runs AFTER this
        // one — so on this screen the plan always describes the PREVIOUS run. Trusting it
        // first asked about agents the customer had just deselected (a Teams-only selection
        // was offered the Outlook choice, left over from an earlier run).
        //
        // But sessionStorage is per browser TAB and goes empty on a restart, in a new tab,
        // or when a session is resumed from a URL. When it did, this page believed NO agents
        // were selected and rendered none of the per-agent sections — including the
        // Outlook/Teams choice — with no error at all. That is not cosmetic: an agent whose
        // choice never rendered deploys with NO tools for that service ("uses Outlook; no
        // decision recorded"), which is exactly what this screen exists to prevent.
        //
        // So: the tab's live selection when there is one, the last plan when there is not.
        // Stale-but-present beats silently-empty, and an over-broad question is visible to
        // the customer where a missing one is not.
        let agentSelection: Array<{ env: string; botIds: string[] }> = [];
        try {
          agentSelection = JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
        } catch {
          agentSelection = [];
        }
        if (!agentSelection.some((sel) => sel.botIds?.length)) {
          try {
            agentSelection = await fetchSelection(session);
          } catch {
            // Leave it empty — the sections below render their own empty states rather
            // than this failing the whole page.
          }
        }
        const envsWithAgents = agentSelection.filter((sel) => (sel.botIds?.length ?? 0) > 0);
        setEnvsWithAgents(envsWithAgents);

        // 1. Scan PA flows for third-party connector dependencies, once per
        //    selected environment.
        let flowConnectors: DetectedConnector[] = [];
        try {
          const flowResults = await Promise.all(
            envsWithAgents.map((sel) => fetchThirdPartyConnectors(session, sel.env)),
          );
          flowConnectors = mergeDetectedConnectors(flowResults);
        } catch {
          // non-fatal — knowledge connectors still shown
        }

        // 2. Scan knowledge sources for connectors (e.g. Confluence) using the
        //    same per-environment agent selection (envsWithAgents/agentSelection
        //    hoisted above — reused below for the SharePoint-as-knowledge scan too).
        let knowledgeConnectors: DetectedConnector[] = [];
        try {
          const ksResults = await Promise.all(
            envsWithAgents.map((sel) => fetchKnowledgeSourceConnectors(session, sel.env, sel.botIds)),
          );
          knowledgeConnectors = mergeDetectedConnectors(ksResults);
        } catch {
          // non-fatal — flow connectors still shown
        }

        // Merge flow + knowledge connectors (deduplicate by connectorId).
        const all = mergeDetectedConnectors([flowConnectors, knowledgeConnectors]);

        // SharePoint/OneDrive used as a KNOWLEDGE source needs the same Azure app as the
        // action connectors — the migrator crawls it through Microsoft Graph and the
        // live tools call Graph at runtime. Detection above only covers Power Automate
        // connectors, so an agent whose SharePoint is knowledge-only reached this step
        // with nothing to fill in and no way to supply credentials.
        let knowledgeMsIds: string[] = [];
        try {
          // Scoped + per-environment like the two scans above — the previous call
          // omitted botIds (scanning every agent in the environment, not just the
          // selected ones) and only checked agentSelection[0]?.env, silently missing
          // SharePoint/OneDrive needs in any other selected environment.
          const neededResults = await Promise.all(
            envsWithAgents.map((sel) => fetchConnectorsNeeded(session, sel.env, sel.botIds)),
          );
          const needed = neededResults.flat();
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
          // Pass the environment. A CUSTOM connector is defined per environment, so
          // without one the server cannot resolve its definition and renders it as
          // `unknown` — no name, no credential field — which is exactly the connector
          // the customer most needs to configure, since it is the one we cannot
          // describe from a built-in registry.
          const reqs = await fetchConnectorRequirements(
            session,
            [...new Set([...all.map((c) => c.connectorId), ...ms])],
            envsWithAgents[0]?.env,
          );
          setRequirements(new Map(reqs.map((r) => [r.connectorId, r])));
        } catch {
          /* no permission guidance available */
        }
        // The customer's own connectors, asked of the platform rather than looked up in a
        // registry that by definition cannot contain them. Surfaced here so one is never
        // discovered mid-migration: the one in the test tenant was published the same day
        // as the agent that used it.
        try {
          const envUrl = envsWithAgents[0]?.env;
          if (envUrl) setCustomConnectors(await fetchCustomConnectors(session, envUrl));
        } catch {
          /* best-effort: the cards below still render */
        }
        setLoading(false);
      } catch {
        setError('Could not scan for connector dependencies. Make sure Microsoft is connected.');
        setLoading(false);
      }
    })();
  }, [session]);

  const totalFound = connectors.length + msIds.length;

  // Bucket callable third-party connectors by shared credential group (e.g. Confluence
  // + Jira both resolve to req.group.id === 'atlassian') vs. standalone — a connector
  // only lands in a group bucket once `requirements` has resolved its `group`, so on
  // the (rare) requirements-fetch failure it falls back to its own ConnectorCard
  // instead of vanishing.
  // "Callable" means we can build a real call for it — NOT that it is in our registry.
  //
  // A CUSTOM connector never has a registry `def`: it was built in the customer's own
  // tenant and named whatever they typed. Requiring `def` here dropped it into the
  // unsupported bucket, so the screen showed "we don't support this connector yet" on the
  // same card that said "all 4 operations map to Get CRM objects from Hubspot's own API" —
  // two contradictory sentences about a connector that binds and has a credential field
  // waiting to be filled (reported from this screen live 2026-08-13). Worse, being in that
  // bucket meant there was nowhere to enter its token.
  //
  // Server-side readiness is the authority: if it lists bindable operations, the connector
  // is callable and belongs in the configurable list with everything else.
  const displayDefFor = (c: DetectedConnector): ConnectorDef => ({
    id: c.connectorId,
    // The customer's own name for it, never the percent-encoded id.
    name: c.readiness?.displayName ?? c.connectorId,
    category: 'custom',
    icon: '🔧',
    // Fields come from the server (`req.fields`) for custom connectors; the registry has none.
    credentials: [],
  });
  const callableConnectors = connectors
    .filter((c) => !c.unsupported && (!!c.def || !!c.readiness?.bindable.length))
    .map((c) => ({ ...c, def: c.def ?? displayDefFor(c) })) as (DetectedConnector & { def: ConnectorDef })[];
  const groupedConnectors = new Map<string, (DetectedConnector & { def: ConnectorDef })[]>();
  const standaloneConnectors: (DetectedConnector & { def: ConnectorDef })[] = [];
  for (const c of callableConnectors) {
    const groupId = requirements.get(c.connectorId)?.group?.id;
    if (groupId) {
      const list = groupedConnectors.get(groupId) ?? [];
      list.push(c);
      groupedConnectors.set(groupId, list);
    } else {
      standaloneConnectors.push(c);
    }
  }

  return (
    <div className="card wide">
      <div className="step-head">
        <h2>Connector Credentials</h2>
        <p className="lead">
          Some of your agents use outside services — like SharePoint files or automated
          workflows. Add login details for those below so your new Gemini agents can keep
          using them.
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
          No outside connections found for the agents you selected — they only use built-in
          Microsoft features and don't rely on any external service.
        </div>
      )}

      {/* The customer's OWN connectors. Shown whether or not an agent uses one: knowing a
          bindable custom connector exists BEFORE a run is the difference between
          configuring it and discovering it mid-migration. */}
      {!loading && customConnectors && (
        <div style={{ marginBottom: 14 }}>
          {!customConnectors.listed ? (
            <div className="infobox">
              <strong>Custom connectors could not be listed.</strong> Your team may have built
              connectors of its own; we could not read them, so this page may be missing some.
              This is not a statement that you have none.
            </div>
          ) : customConnectors.connectors.length > 0 ? (
            <div className="infobox">
              <strong>
                {customConnectors.connectors.length} custom connector
                {customConnectors.connectors.length !== 1 ? 's' : ''} built by your team
              </strong>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>
                These are yours, not Microsoft's, so they are not in any built-in list — we read
                each one's published definition to work out what it can do.
              </p>
              {customConnectors.connectors.map((c) => (
                <div key={c.connectorId} style={{ marginTop: 8 }}>
                  <div>
                    <strong>{c.displayName}</strong>{' '}
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {c.publisher ? `published by ${c.publisher}` : ''}
                      {c.backendHost ? ` · calls ${c.backendHost}` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, marginTop: 2 }}>
                    {c.bindable ? (
                      <span>
                        ✓ {c.operationCount} operation{c.operationCount !== 1 ? 's' : ''} can be
                        recreated: <code>{c.operations.join(', ')}</code>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--warn, #b45309)' }}>
                        Cannot be recreated — {c.reason ?? 'we could not read its definition.'}
                      </span>
                    )}
                  </div>
                  {c.policyCount > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--warn, #b45309)', marginTop: 2 }}>
                      Applies {c.policyCount} Power Platform policy/policies that rewrite the
                      request before it reaches {c.backendHost ?? 'the service'}. We call the
                      service directly, so results may differ — compare before relying on it.
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {!loading && totalFound > 0 && (
        <div style={{ marginBottom: 8 }}>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
            {totalFound} connector{totalFound !== 1 ? 's' : ''} detected.
            Skip any connector to flag it for manual review in the migration report.
          </p>

          {/* MS native: one shared App Registration card for all MS connectors
              (also covers SharePoint/OneDrive used as a knowledge source — see
              knowledgeMsIds above, which folds those into detectedMsIds). */}
          <MsNativeSection session={session} detectedMsIds={msIds} reqs={requirements} />

          {/* Shared-credential-group connectors: one card per group (e.g. Confluence + Jira
              share the single Atlassian token) instead of one empty, un-fillable card each. */}
          {[...groupedConnectors.entries()].map(([groupId, members]) => (
            <GroupSection key={groupId} session={session} members={members} reqs={requirements} />
          ))}

          {/* Third-party: one card per connector we can actually call, not sharing credentials */}
          {standaloneConnectors.map((c) => (
            <div key={c.connectorId}>
              <ConnectorCard
                c={c}
                session={session}
                alreadySaved={savedIds.has(c.connectorId)}
                req={requirements.get(c.connectorId)}
                onSaved={c.connectorId === 'shared_googledrive' ? () => setShowDriveModal(true) : undefined}
              />
              {/* A single small link, not a permanent card — the popup covers the guided
                  "just saved the key" moment; this is the way back in afterward, e.g. a
                  returning admin or a newly-selected agent that still needs its Drive
                  account confirmed. */}
              {c.connectorId === 'shared_googledrive' && (
                <div style={{ marginTop: -4, marginBottom: 12 }}>
                  <button type="button" className="dlink" onClick={() => setShowDriveModal(true)}>
                    Whose Drive does each agent use? →
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* Detected but not callable — shown, never hidden */}
          {connectors
            .filter((c) => (c.unsupported || !c.def) && !c.readiness?.bindable.length)
            .map((c) => (
              <UnsupportedConnectorCard key={c.connectorId} c={c} />
            ))}
        </div>
      )}

      {/* Cross-vendor surfaces (Outlook -> Gmail). Rendered per environment because the
       *  agent selection is per environment, and it renders nothing at all when no selected
       *  agent uses a Microsoft surface — an empty prompt is noise on every other migration. */}
      {envsWithAgents.map((sel) => (
        <SurfaceEquivalenceChoice
          key={sel.env}
          session={session}
          envUrl={sel.env}
          sourceIds={sel.botIds}
        />
      ))}

      <div className="wizard-actions" style={{ marginTop: 20 }}>
        <button className="wbtn" onClick={() => navigate(`/select-data?session=${session}`)}>← Back</button>
        {/* Straight to Migrate, not /connectors — that page re-scans EVERY agent in
         *  every accessible environment unfiltered by selection, which is exactly
         *  the SharePoint detection this step already covers (scoped to the agents
         *  actually selected). Chaining into it here just asked the same question
         *  twice. /connectors still exists as a standalone full-environment-audit
         *  utility (reachable from SelectMap's inline link), just not forced into
         *  this linear flow anymore. */}
        <button className="wbtn primary" onClick={() => navigate(`/migrate?session=${session}`)}>Continue →</button>
      </div>

      {showDriveModal && (
        <DriveIdentityModal session={session} envsWithAgents={envsWithAgents} onClose={() => setShowDriveModal(false)} />
      )}
    </div>
  );
}
