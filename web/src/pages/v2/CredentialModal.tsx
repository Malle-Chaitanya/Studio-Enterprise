import { useState } from 'react';
import type { ConnectorValidation } from '../../api.ts';
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
  onFocusSecret,
  onCancel,
}: {
  session: string;
  row: ConnectorRow;
  onSaved: (validation: ConnectorValidation | undefined) => void;
  /** Fired when a secret field takes focus, so the driver can record the handoff. */
  onFocusSecret?: (fieldKey: string) => void;
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
        <div className="v2-secnote" style={{ marginBottom: 16 }}>
          <span className="m" aria-hidden="true">i</span>
          <span>
            {group.setupHint}
            {group.setupUrl && (
              <>
                {' '}
                <a href={group.setupUrl} target="_blank" rel="noreferrer">Open the setup page</a>
              </>
            )}
          </span>
        </div>
      )}

      {fields.length === 0 && (
        <div className="v2-secnote">
          <span className="m" aria-hidden="true">i</span>
          <span>
            This connector needs no credential of its own. If it is still not ready, the
            missing piece is a permission grant, not a value.
          </span>
        </div>
      )}

      {fields.map((f) => {
        const secret = isSecret(f);
        if (f.supplied && !replacing.has(f.key)) {
          return (
            <div className={`v2-fld supplied${secret ? ' secret' : ''}`} key={f.key}>
              <label htmlFor={`f-${row.connectorId}-${f.key}`}>{f.label} <em>— already stored</em></label>
              <input
                id={`f-${row.connectorId}-${f.key}`}
                className="v2-field"
                value="•••••••• in Secret Manager"
                disabled
                readOnly
              />
              <span className="byagent">
                Never read back into this page.{' '}
                <button
                  type="button"
                  className="dlink"
                  onClick={() => setReplacing((r) => new Set(r).add(f.key))}
                >
                  Replace it
                </button>
              </span>
            </div>
          );
        }
        return (
          <div
            className={`v2-fld${secret ? ' secret' : ''}`}
            key={f.key}
            data-agent-target={`field:${row.connectorId}:${f.key}`}
          >
            <label htmlFor={`f-${row.connectorId}-${f.key}`}>
              {f.label}
              {f.shared && <em> — shared across this group</em>}
              {replacing.has(f.key) && <em> — replacing the stored value</em>}
            </label>
            <input
              id={`f-${row.connectorId}-${f.key}`}
              className="v2-field"
              type={secret ? 'password' : 'text'}
              value={values[f.key] ?? ''}
              placeholder={f.placeholder ?? ''}
              autoComplete="off"
              onFocus={() => { if (secret) onFocusSecret?.(f.key); }}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
            {f.hint && <span className="hint">{f.hint}</span>}
          </div>
        );
      })}

      {permissions.length > 0 && (
        <div className="v2-secnote">
          <span className="m" aria-hidden="true">✓</span>
          <span>
            Grant these as <b>application</b> permissions, then admin-consent them — a token
            is issued even with nothing consented, so every call would 403 at run time:
            <br />
            <span className="mono">{permissions.join(', ')}</span>
          </span>
        </div>
      )}

      {validation && (
        <div
          className={`v2-test ${validation.code === 'ok' ? 'ok' : validation.code === 'unverified' || validation.code === 'unreachable' ? '' : 'bad'}`}
          style={{ marginTop: 14 }}
        >
          <span aria-hidden="true">{validation.code === 'ok' ? '✓' : '!'}</span>
          <span>{validation.detail || VALIDATION_TEXT[validation.code]}</span>
        </div>
      )}
      {error && (
        <div className="v2-test bad" style={{ marginTop: 14 }}>
          <span aria-hidden="true">!</span>
          <span>{error}</span>
        </div>
      )}

      <div className="v2-fld-f">
        <span className="v2-test">
          {saving ? <span className="v2-spin-d" aria-hidden="true" /> : <span aria-hidden="true">🔒</span>}
          <span>{saving ? 'Writing to Secret Manager…' : 'Values go straight to Secret Manager'}</span>
        </span>
        <span className="sp">
          {onCancel && (
            <button type="button" className="v2-btn" onClick={onCancel}>
              {validation ? 'Done' : 'Cancel'}
            </button>
          )}
          <button type="button" className="v2-btn blue" onClick={() => void save()} disabled={!canSave || saving}>
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
  session, row, onClose, onSaved, onFocusSecret,
}: {
  session: string;
  row: ConnectorRow;
  onClose: () => void;
  onSaved: (validation: ConnectorValidation | undefined) => void;
  onFocusSecret?: (fieldKey: string) => void;
}) {
  const group = row.req?.group;
  return (
    <>
      <div className="v2-scrim" onClick={onClose} />
      <div className="v2-modal" role="dialog" aria-modal="true" aria-label={`Connect ${row.name}`}>
        <div className="v2-modal-h">
          <span className="glyph" aria-hidden="true">{row.req?.icon ?? row.name.slice(0, 2).toUpperCase()}</span>
          <div>
            <h3>Connect {row.name}</h3>
            <div className="sub">
              {group
                ? `${group.name} — one credential serves ${group.siblings.length + 1} connectors`
                : `Needed by ${row.agentNames.length || row.flowNames.length} item(s) in this migration`}
            </div>
          </div>
          <button type="button" className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="v2-modal-b">
          <CredentialForm
            session={session}
            row={row}
            onSaved={onSaved}
            onFocusSecret={onFocusSecret}
            onCancel={onClose}
          />
        </div>
      </div>
    </>
  );
}
