import { useState } from 'react';
import type { ConnectorValidation } from '../../api.ts';
import { ConnectorMark } from '../../components/v2/connectorMarks.tsx';
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

  const group = row.req?.group;
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

  const permissions = row.req?.requiredPermissions ?? [];

  return (
    <>
      {group?.setupHint && (
        <div className="cf-alert cf-alert--info" style={{ marginBottom: 16 }}>
          <span className="cf-alert__icon" aria-hidden="true">&#8505;</span>
          <div>
            <p className="cf-alert__desc">
              {group.setupHint}
              {group.setupUrl && (
                <>
                  {' '}
                  <a href={group.setupUrl} target="_blank" rel="noreferrer">Open the setup page</a>
                </>
              )}
            </p>
          </div>
        </div>
      )}

      {fields.length === 0 && (
        <div className="cf-alert cf-alert--info">
          <span className="cf-alert__icon" aria-hidden="true">&#8505;</span>
          <div>
            <p className="cf-alert__desc">
              This connector needs no credential of its own. If it is still not ready, the
              missing piece is a permission grant, not a value.
            </p>
          </div>
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
              <input
                id={`f-${row.connectorId}-${f.key}`}
                className="cf-input"
                value="•••••••• in Secret Manager"
                disabled
                readOnly
                style={{ color: 'var(--cf-color-muted)' }}
              />
              <span className="cf-hint">
                Never read back into this page.{' '}
                <button
                  type="button"
                  className="cf-btn--linklike"
                  onClick={() => setReplacing((r) => new Set(r).add(f.key))}
                >
                  Replace it
                </button>
              </span>
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

      {permissions.length > 0 && (
        <div className="cf-alert cf-alert--success" style={{ marginBottom: 16 }}>
          <span className="cf-alert__icon" aria-hidden="true">&#10003;</span>
          <div>
            <p className="cf-alert__desc">
              Grant these as <b>application</b> permissions, then admin-consent them — a token
              is issued even with nothing consented, so every call would 403 at run time:
              <br />
              <span style={{ fontFamily: 'var(--cf-mono, monospace)' }}>{permissions.join(', ')}</span>
            </p>
          </div>
        </div>
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
            <button type="button" className="cf-btn cf-btn--secondary" onClick={onCancel}>
              {validation ? 'Done' : 'Cancel'}
            </button>
          )}
          <button
            type="button"
            className="cf-btn cf-btn--primary"
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
  return (
    <div className="cf-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cf-modal" role="dialog" aria-modal="true" aria-label={`Connect ${row.name}`}>
        <div className="cf-modal__header">
          <span className="cf-connector-glyph" aria-hidden="true">
            <ConnectorMark connectorId={row.connectorId} name={row.name} emojiHint={row.req?.icon} />
          </span>
          <div style={{ flex: 1 }}>
            <h3 className="cf-modal__title">{group?.name ?? row.name}</h3>
            <div className="cf-hint">
              {group
                ? `${group.siblings.length + 1} connector${group.siblings.length ? 's' : ''}${row.agentNames.length ? ` · ${row.agentNames.length} agent${row.agentNames.length > 1 ? 's' : ''}` : ''}`
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
                <button type="button" className="cf-btn cf-btn--secondary cf-btn--sm" onClick={onForget}>
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
