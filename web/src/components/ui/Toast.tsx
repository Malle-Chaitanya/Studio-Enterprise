import { useEffect } from 'react';

export type ToastType = 'success' | 'error' | 'warn' | 'info';

interface Props {
  message: string;
  type?: ToastType;
  onHide: () => void;
  duration?: number;
}

const icons: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  warn: '⚠',
  info: 'ℹ',
};

export function Toast({ message, type = 'success', onHide, duration = 3200 }: Props) {
  useEffect(() => {
    const t = setTimeout(onHide, duration);
    return () => clearTimeout(t);
  }, [onHide, duration]);

  return (
    <div className={`toast toast-${type}`}>
      <span className="toast-icon">{icons[type]}</span>
      {message}
    </div>
  );
}

export interface ToastState {
  message: string;
  type: ToastType;
  id: number;
}
