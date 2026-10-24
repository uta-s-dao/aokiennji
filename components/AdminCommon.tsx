'use client';
import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, X } from 'lucide-react';
export function Notice({
  message,
  type = 'success',
  onClose,
}: {
  message: string;
  type?: 'success' | 'error';
  onClose?: () => void;
}) {
  if (!message) return null;
  return (
    <div className={`admin-notice ${type}`} role="status">
      {type === 'success' && <CheckCircle2 size={18} />}
      <span>{message}</span>
      {onClose && (
        <button aria-label="通知を閉じる" type="button" onClick={onClose}>
          <X size={16} />
        </button>
      )}
    </div>
  );
}
export function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="state-box">
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current?.querySelector<HTMLElement>('input,button,select,textarea,a[href]')?.focus();
    const handler = (e: KeyboardEvent) => {
      const all = document.querySelectorAll('.modal-card');
      if (panel.current !== all[all.length - 1]) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      }
      if (e.key === 'Tab') {
        const nodes = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],iframe',
          ) || [],
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        className={`modal-card ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="閉じる" type="button" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </section>
    </div>
  );
}
export function useNotice() {
  const [message, setMessage] = useState(''),
    [error, setError] = useState('');
  return {
    message,
    error,
    success: (s: string) => {
      setMessage(s);
      setError('');
    },
    fail: (s: string) => {
      setError(s);
      setMessage('');
    },
    clear: () => {
      setMessage('');
      setError('');
    },
  };
}
