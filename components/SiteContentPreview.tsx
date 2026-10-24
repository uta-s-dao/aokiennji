'use client';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './AdminCommon';

export default function SiteContentPreview({
  revision,
  view,
  anchor,
  onClose,
}: {
  revision: number;
  view: 'home' | 'projects';
  anchor: string;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [available, setAvailable] = useState(800);
  const [mobile, setMobile] = useState(false);
  const [loading, setLoading] = useState(true);
  const width = mobile ? 390 : 1440;
  const scale = Math.min(1, available / width);
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data === 'site-preview-close'
      )
        onClose();
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [onClose]);
  return (
    <Modal title="下書きプレビュー" wide onClose={onClose}>
      <div className="cms-actions" role="group" aria-label="プレビューの画面幅">
        <button
          type="button"
          className="button secondary small"
          aria-pressed={!mobile}
          onClick={() => {
            if (mobile) {
              setLoading(true);
              setMobile(false);
            }
          }}
        >
          PC表示
        </button>
        <button
          type="button"
          className="button secondary small"
          aria-pressed={mobile}
          onClick={() => {
            if (!mobile) {
              setLoading(true);
              setMobile(true);
            }
          }}
        >
          スマートフォン表示
        </button>
        <span className="muted">
          {width}px幅・{Math.round(scale * 100)}%表示
        </span>
      </div>
      <p className="help">保存済みの内容です。枠内をスクロールして確認できます。</p>
      {loading && <p role="status">プレビューを読み込んでいます…</p>}
      <div className="cms-preview-viewport" ref={container}>
        <div style={{ width: width * scale, height: 650 }}>
          <iframe
            ref={frame}
            key={`${revision}-${view}-${anchor}-${mobile}`}
            title="保存した下書き"
            src={`/admin/site-preview?view=${view}&anchor=${encodeURIComponent(anchor)}`}
            style={{
              width,
              height: 650 / scale,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
            onLoad={() => setLoading(false)}
          />
        </div>
      </div>
    </Modal>
  );
}
