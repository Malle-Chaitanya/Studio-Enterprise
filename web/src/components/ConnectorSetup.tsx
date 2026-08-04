import { useEffect, useState } from 'react';
import {
  fetchSession,
  fetchSharePointConnectorStatus,
  removeSharePointConnector,
  setUpSharePointConnector,
  type SharePointConnectorStatus,
} from '../api.ts';

/**
 * Inline SharePoint connector setup/status for one site. The admin only needs
 * to re-enter Entra credentials for a genuinely new Microsoft tenant — an
 * already-onboarded tenant reuses its stored Secret Manager credential
 * server-side, so this form is optional-credential by design (see
 * .claude/memory/decisions.md, 2026-08-03).
 *
 * Shared between the per-agent Explore assessment and the flat, batch
 * Connectors list — same panel, two entry points.
 */
export function ConnectorSetup({ session, siteUrl }: { session: string; siteUrl: string }) {
  const [status, setStatus] = useState<SharePointConnectorStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const refresh = () => {
    setChecking(true);
    fetchSharePointConnectorStatus(session, siteUrl)
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setChecking(false));
  };

  useEffect(refresh, [session, siteUrl]);

  // Pre-fill Tenant ID from the Microsoft OAuth connection made back in
  // "Connect Platforms" — the app already knows it, so don't make the admin
  // retype it. Client ID/Secret are the customer's SEPARATE Entra app
  // registration for the connector itself and are never known ahead of time.
  useEffect(() => {
    fetchSession(session)
      .then((s) => { if (s.tenantId) setTenantId((prev) => prev || s.tenantId!); })
      .catch(() => { /* best-effort prefill only — form still works without it */ });
  }, [session]);

  const submit = async () => {
    if (!tenantId.trim()) { setSubmitError('Tenant ID is required.'); return; }
    setSubmitting(true);
    setSubmitError('');
    try {
      await setUpSharePointConnector(session, {
        siteUrl,
        tenantId: tenantId.trim(),
        clientId: clientId.trim() || undefined,
        clientSecret: clientSecret.trim() || undefined,
      });
      setShowForm(false);
      setClientSecret(''); // never linger in this component's state longer than needed
      refresh();
    } catch (e) {
      // Show the REAL backend/Google reason, not a generic message — a real
      // cause hidden behind "check the values and try again" wastes far more
      // time than it saves (confirmed the hard way this session).
      setSubmitError((e as Error).message || 'Could not start connector setup — check the values and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    setRemoving(true);
    try {
      await removeSharePointConnector(session, siteUrl);
      refresh();
    } finally {
      setRemoving(false);
    }
  };

  if (checking) return <p className="ksdetail" style={{ marginTop: 6 }}>Checking connector status…</p>;

  if (status?.status === 'done') {
    return (
      <p className="ksdetail" style={{ marginTop: 6, color: 'var(--green, #1a7f37)' }}>
        ✓ Connector ready — attaches automatically during migration.{' '}
        <button className="dlink" onClick={remove} disabled={removing}>
          {removing ? 'Removing…' : 'Remove & set up again'}
        </button>
      </p>
    );
  }
  if (status?.status === 'pending' && status.checkError) {
    return (
      <p className="kswarn" style={{ marginTop: 6 }}>
        ⚠ Couldn't confirm status: {status.checkError}{' '}
        <button className="dlink" onClick={refresh}>Try again</button>{' '}
        <button className="dlink" onClick={remove} disabled={removing}>
          {removing ? 'Removing…' : 'Remove & start over'}
        </button>
      </p>
    );
  }
  if (status?.status === 'pending') {
    return (
      <p className="ksdetail" style={{ marginTop: 6 }}>
        ⏳ Connector provisioning… <button className="dlink" onClick={refresh}>Refresh</button>
      </p>
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      {status?.status === 'failed' && (
        <p className="kswarn">
          ⚠ Connector setup failed: {status.error ?? 'unknown error'}{' '}
          <button className="dlink" onClick={remove} disabled={removing}>
            {removing ? 'Removing…' : 'Remove & start over'}
          </button>
        </p>
      )}
      {!showForm ? (
        <button className="dlink" onClick={() => setShowForm(true)}>Set up SharePoint connector for this site</button>
      ) : (
        <div className="infobox" style={{ marginTop: 6 }}>
          <p className="lead" style={{ margin: '0 0 8px' }}>
            Site: <span className="mono">{siteUrl}</span>. If this tenant was already onboarded, leave Client
            ID/Secret blank — the stored credential is reused automatically.
          </p>
          <input className="usearch" style={{ marginBottom: 6 }} placeholder="Tenant ID (required)" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
          <input className="usearch" style={{ marginBottom: 6 }} placeholder="Client ID (new tenant only)" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          <input className="usearch" style={{ marginBottom: 6 }} type="password" placeholder="Client Secret (new tenant only)" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
          {submitError && <p className="kswarn">{submitError}</p>}
          <button className="btn primary" disabled={submitting} onClick={submit}>
            {submitting ? 'Starting…' : 'Start connector setup'}
          </button>
          <button className="wbtn" style={{ marginLeft: 8 }} onClick={() => setShowForm(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
