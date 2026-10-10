import { useState } from 'react';
import { openAuthorizeUrlPopup, type ConnectorValidation } from '../../api.ts';
import { ConnectorMark, groupIconOverride } from '../../components/v2/connectorMarks.tsx';
import { IcoPencil } from '../../icons.tsx';
import { useSource, type ConnectorRow } from '../../v2/data/index.ts';

/** Field types that hold a secret. The agent may never fill one of these. */
const SECRET_TYPES = new Set(['password', 'secret', 'token']);
const isSecret = (f: { key: string; type: string }): boolean =>
  SECRET_TYPES.has(f.type) || /secret|token|password|api_key/i.test(f.key);

const VALIDATION_TEXT: Record<ConnectorValidation['code'], string> = {
  // "saved", never "updated": re-saving an identical value is a deliberate no-op
  // server-side, so claiming an update would describe something that did not happen.
  ok: 'Saved and tested against the provider — the credential works.',
  invalid_credentials: 'The provider rejected these values. Check them and save again.',
  permission_denied: 'The credential is valid but not permitted. Someone must grant the permissions below.',
  unreachable: 'Could not reach the provider to test this. Saved, but unverified.',
  unverified: 'Saved. We do not test this connector, so this is not proof it works.',
};

const VALIDATION_TONE: Record<ConnectorValidation['code'], 'success' | 'danger' | 'warning' | 'info'> = {
  ok: 'success',
  invalid_credentials: 'danger',
  permission_denied: 'warning',
  unreachable: 'info',
  unverified: 'info',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Lets ONE named person connect their own Microsoft account, for connectors whose tools ran
 * as the signed-in Copilot user in the source agent (`userAuth.supported`). The shared
 * app-only credential above this is necessary but not sufficient for those tools — without
 * this, saving the app registration alone leaves them permanently broken after migration.
 *
 * The why (which permission this needs, where to grant it) is explained in the Inspector's
 * "How to connect" guide, not here — this box is only the credential entry + the sign-in
 * action itself.
 */
function DelegatedSignIn({
  session, connectorId,
}: {
  session: string;
  connectorId: string;
}) {
  const source = useSource();
  const [userKey, setUserKey] = useState('');
  /**
   * `already-connected` (a passive background check, e.g. on blurring the email field) and
   * `just-connected` (the actual popup sign-in just completed) are deliberately DIFFERENT
   * states, not one shared "connected" — collapsing them looked, from the outside, like the
   * Sign-in button worked on the first click when it had not run yet at all: focus moves to
   * the button before its onClick fires, so the field's onBlur check landed first, found an
   * already-stored secret (from earlier testing), and showed "Connected" a frame before the
   * click did anything. Found live 2026-10-07.
   */
  const [status, setStatus] = useState<
    'idle' | 'checking' | 'connecting' | 'already-connected' | 'just-connected' | 'not-connected' | 'error'
  >('idle');
  const [message, setMessage] = useState('');

  const check = async (key: string): Promise<void> => {
    setStatus('checking');
    setMessage('');
    try {
      const res = await source.connectors.consentStatus(session, connectorId, key);
      setStatus(res.connected ? 'already-connected' : 'not-connected');
    } catch {
      setStatus('error');
      setMessage('Could not check connection status.');
    }
  };

  const connect = async (): Promise<void> => {
    const key = userKey.trim();
    if (!key) return;
    setStatus('connecting');
    setMessage('');
    try {
      const { authorizeUrl } = await source.connectors.startConsent(session, connectorId, key);
      // Empty means the flow already resolved without a round trip (the fixture source's
      // shortcut) — the real backend always returns a real Microsoft URL here.
      if (authorizeUrl) {
        const result = await openAuthorizeUrlPopup(authorizeUrl, 'connector-consent-ok', 'connector-consent-error');
        if (!result.ok) {
          setStatus('error');
          setMessage(
            result.error === 'closed'
              ? 'Sign-in window closed before finishing.'
              : (result.error || 'Sign-in failed.'),
          );
          return;
        }
      }
      // Confirm the secret actually landed rather than trusting the popup's own say-so —
      // and report it as a FRESH connect, not the passive "already connected" check's wording.
      const res = await source.connectors.consentStatus(session, connectorId, key);
      if (res.connected) {
        setStatus('just-connected');
      } else {
        setStatus('error');
        setMessage('Microsoft reported success, but the credential was not found afterward. Try again.');
      }
    } catch (e) {
      setStatus('error');
      setMessage((e as Error).message || 'consent_start_failed');
    }
  };

  return (
    <div className="cf-field" style={{ margin: '0 0 16px' }}>
      <label className="cf-label" htmlFor={`consent-${connectorId}`}>
        Per-person sign-in
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          id={`consent-${connectorId}`}
          className="cf-input"
          type="email"
          placeholder="Person's Microsoft email, e.g. erik@contoso.com"
          value={userKey}
          onChange={(e) => { setUserKey(e.target.value); setStatus('idle'); setMessage(''); }}
          onBlur={() => { if (EMAIL_RE.test(userKey.trim())) void check(userKey.trim()); }}
        />
        <button
          type="button"
          className="cf-btn cf-btn--primary cf-btn--sm"
          style={{ flex: '0 0 auto' }}
          disabled={!EMAIL_RE.test(userKey.trim()) || status === 'connecting' || status === 'checking'}
          onClick={() => void connect()}
        >
          {status === 'connecting' ? 'Connecting…' : 'Sign in with Microsoft'}
        </button>
      </div>
      {status === 'checking' && <span className="cf-hint">Checking…</span>}
      {status === 'already-connected' && (
        <span className="cf-hint" style={{ color: 'var(--cf-color-success, #0a5c3a)' }}>
          &#10003; Already connected as {userKey.trim()} — sign in again only to refresh or replace it.
        </span>
      )}
      {status === 'just-connected' && (
        <span className="cf-hint" style={{ color: 'var(--cf-color-success, #0a5c3a)' }}>
          &#10003; Signed in just now as {userKey.trim()}.
        </span>
      )}
      {status === 'not-connected' && <span className="cf-hint">Not connected yet for this person.</span>}
      {status === 'error' && (
        <span className="cf-hint" style={{ color: 'var(--cf-color-danger, #7a1414)' }}>{message}</span>
      )}
    </div>
  );
}

/**
 * Enter a connector's credentials.
 *
 * Two invariants live in this component:
 *  1. A field already in Secret Manager is shown as supplied and never re-asked —
 *     and its value is never fetched or displayed, not even masked.
 *  2. The agent does not type here. Secret fields are the human's, always; the
 *     agent's job is to open this dialog on the right connector and then stop.
 */
export function CredentialForm({
  session,
  row,
  onSaved,
  onCancel,
}: {
  session: string;
  row: ConnectorRow;
  onSaved: (validation: ConnectorValidation | undefined) => void;
  /** Fired when a secret field takes focus, so the driver can record the handoff. */
  /** Present in a dialog, absent inline — an inline form has nothing to cancel. */
  onCancel?: () => void;
}) {
  const source = useSource();
  const fields = row.req?.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  /**
   * Fields the person has chosen to replace.
   *
   * A stored credential still has to be changeable — tokens get rotated and get
   * entered wrong — but it is never pre-filled and never read back, so replacing
   * means typing a new value, not editing an old one. Opt-in per field so a visit
   * to review cannot overwrite something by accident.
   */
  const [replacing, setReplacing] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<ConnectorValidation | null>(null);

  const outstanding = fields.filter((f) => !f.supplied || replacing.has(f.key));
  const canSave = outstanding.length > 0 && outstanding.every((f) => (values[f.key] ?? '').trim().length > 0);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      const creds = outstanding
        .map((f) => ({ field: f.key, value: (values[f.key] ?? '').trim() }))
        .filter((c) => c.value.length > 0);
      const res = await source.connectors.save(session, row.connectorId, creds);
      setValidation(res.validation ?? { code: 'unverified' });
      // Drop the plaintext the moment the write returns — it lives in Secret
      // Manager now, and there is no reason for it to stay in browser memory.
      setValues({});
      onSaved(res.validation);
    } catch (e) {
      setError((e as Error).message || 'credentials_save_failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* What this needs and where to grant it (setup hint, permissions, redirect URI) is
          the Inspector's "How to connect" guide now, not a wall of alerts in this dialog —
          this body is credential entries + sign-in only. See ConnectorsV2.tsx. */}
      {fields.length === 0 && !row.req?.userAuth?.supported && (
        <div className="cf-alert cf-alert--info">
          <span className="cf-alert__icon" aria-hidden="true">&#8505;</span>
          <div><p className="cf-alert__desc">No credential needed for this connector.</p></div>
        </div>
      )}

      {fields.map((f) => {
        const secret = isSecret(f);
        if (f.supplied && !replacing.has(f.key)) {
          return (
            <div className="cf-field" key={f.key}>
              <label className="cf-label" htmlFor={`f-${row.connectorId}-${f.key}`}>
                {f.label} <em className="cf-hint" style={{ fontStyle: 'normal' }}>— already stored</em>
              </label>
              <div className="cf-input-wrap">
                <input
                  id={`f-${row.connectorId}-${f.key}`}
                  className="cf-input"
                  value="•••••••• in Secret Manager"
                  disabled
                  readOnly
                  style={{ color: 'var(--cf-color-muted)' }}
                />
                <button
                  type="button"
                  className="cf-input-icon-btn"
                  title={`Replace ${f.label}`}
                  aria-label={`Replace ${f.label}`}
                  onClick={() => setReplacing((r) => new Set(r).add(f.key))}
                >
                  <IcoPencil s={14} />
                </button>
              </div>
              <span className="cf-hint">Never read back into this page.</span>
            </div>
          );
        }
        return (
          <div className="cf-field" key={f.key} data-agent-target={`field:${row.connectorId}:${f.key}`}>
            <label className="cf-label" htmlFor={`f-${row.connectorId}-${f.key}`}>
              {f.label}
              {f.shared && <em className="cf-hint" style={{ fontStyle: 'normal' }}> — shared across this group</em>}
              {replacing.has(f.key) && <em className="cf-hint" style={{ fontStyle: 'normal' }}> — replacing the stored value</em>}
            </label>
            <input
              id={`f-${row.connectorId}-${f.key}`}
              className="cf-input"
              type={secret ? 'password' : 'text'}
              value={values[f.key] ?? ''}
              placeholder={f.placeholder ?? ''}
              autoComplete="off"
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
            {f.hint && <span className="cf-hint">{f.hint}</span>}
            {/* Said here, on the field, rather than by dimming the page and
                announcing it: this value is written straight to Secret Manager and
                is never read back into the browser. */}
            {secret && !f.supplied && (
              <span className="cf-hint">Goes straight to Secret Manager — never read back into this page.</span>
            )}
          </div>
        );
      })}

      {row.req?.userAuth?.supported && (
        <DelegatedSignIn session={session} connectorId={row.connectorId} />
      )}

      {validation && (
        <div className={`cf-alert cf-alert--${VALIDATION_TONE[validation.code]}`} style={{ marginTop: 14 }}>
          <span className="cf-alert__icon" aria-hidden="true">{validation.code === 'ok' ? '✓' : '!'}</span>
          <div><p className="cf-alert__desc">{validation.detail || VALIDATION_TEXT[validation.code]}</p></div>
        </div>
      )}
      {error && (
        <div className="cf-alert cf-alert--danger" style={{ marginTop: 14 }}>
          <span className="cf-alert__icon" aria-hidden="true">!</span>
          <div><p className="cf-alert__desc">{error}</p></div>
        </div>
      )}

      <div className="cf-credfoot">
        <span className="cf-credfoot__note">
          {saving ? <span className="cf-spinner" aria-hidden="true" /> : <span aria-hidden="true">&#128274;</span>}
          <span>{saving ? 'Writing to Secret Manager…' : 'Values go straight to Secret Manager'}</span>
        </span>
        <span className="cf-credfoot__actions">
          {onCancel && (
            <button type="button" className="cf-btn cf-btn--secondary cf-btn--light" onClick={onCancel}>
              {validation ? 'Done' : 'Cancel'}
            </button>
          )}
          <button
            type="button"
            className="cf-btn cf-btn--primary cf-btn--light"
            onClick={() => void save()}
            disabled={!canSave || saving}
          >
            {saving ? 'Saving…' : 'Save and test'}
          </button>
        </span>
      </div>
    </>
  );
}

/**
 * The same form in a dialog, for the places that still want one (the agent
 * opening a specific connector). The fields themselves live in CredentialForm so
 * the inline step list and the dialog cannot drift apart.
 */
export function CredentialModal({
  session, row, onClose, onSaved, onForget,
}: {
  session: string;
  row: ConnectorRow;
  onClose: () => void;
  onSaved: (validation: ConnectorValidation | undefined) => void;
  /** Present only when this connector already has something saved. */
  onForget?: () => void;
}) {
  const group = row.req?.group;
  // Same group-level override as the tile grid: a group's icon is its own brand mark, never
  // borrowed from whichever connector happens to be the row this modal was opened for.
  const iconUrl = groupIconOverride(group?.id) ?? row.req?.iconUrl;
  return (
    <div className="cf-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cf-modal" role="dialog" aria-modal="true" aria-label={`Connect ${row.name}`}>
        <div className="cf-modal__header">
          <span className="cf-connector-glyph" aria-hidden="true">
            <ConnectorMark connectorId={row.connectorId} name={row.name} emojiHint={row.req?.icon} iconUrl={iconUrl} />
          </span>
          <div style={{ flex: 1 }}>
            <h3 className="cf-modal__title">{group?.name ?? row.name}</h3>
            {/* How many connectors a shared App Registration unlocks across the WHOLE
                registry (all ~105 Microsoft connectors it could ever serve) was not a useful
                number here — it never changes with what this migration actually uses. The
                agent count is: how many agents in THIS migration need it. */}
            <div className="cf-hint">
              {group
                ? row.agentNames.length
                  ? `Needed by ${row.agentNames.length} agent${row.agentNames.length > 1 ? 's' : ''} in this migration`
                  : 'Shared Microsoft credential'
                : `Needed by ${row.agentNames.length || row.flowNames.length} item(s) in this migration`}
            </div>
          </div>
          <button type="button" className="cf-modal__close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="cf-modal__body">
          <CredentialForm
            session={session}
            row={row}
            onSaved={onSaved}
            onCancel={onClose}
          />
          {onForget && (
            <div className="cf-alert cf-alert--info" style={{ marginTop: 14 }}>
              <span className="cf-alert__icon" aria-hidden="true">&#8505;</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', width: '100%' }}>
                <p className="cf-alert__desc" style={{ flex: 1 }}>
                  Stored earlier. Forgetting only drops our record — the Secret Manager secret stays.
                </p>
                <button type="button" className="cf-btn cf-btn--secondary cf-btn--light" onClick={onForget}>
                  Forget stored credentials
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
