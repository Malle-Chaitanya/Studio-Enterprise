import { IcoTrash } from '../icons.tsx';

interface ConfirmDialogProps {
  title: string;
  /** Highlighted account/resource identifier, e.g. an email or tenant id. */
  detail?: string;
  /** Fine-print consequence text below the detail box. */
  note?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Branded destructive-action confirmation — replaces window.confirm() for
 *  actions like disconnecting a platform. Click outside or Cancel to back out. */
export function ConfirmDialog({ title, detail, note, confirmLabel = 'Confirm', onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-icon">
            <IcoTrash s={20} />
          </div>
          <div className="modal-title">{title}</div>
        </div>
        {detail && <div className="modal-detail">{detail}</div>}
        {note && <div className="modal-note">{note}</div>}
        <div className="modal-actions">
          <button type="button" className="wbtn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="wbtn danger" onClick={onConfirm}>
            <IcoTrash s={13} /> {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
