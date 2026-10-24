'use client';
import { useEffect } from 'react';

export default function SitePreviewPosition({ anchor }: { anchor: string }) {
  useEffect(() => {
    const target = document.getElementById(anchor);
    const position = () => target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    position();
    let active = true;
    const images = [...document.images].filter((image) => image.loading !== 'lazy');
    void Promise.allSettled([document.fonts.ready, ...images.map((image) => image.decode())]).then(
      () => {
        if (active) position();
      },
    );
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && parent !== window)
        parent.postMessage('site-preview-close', location.origin);
      // Return Tab focus to the surrounding dialog at the iframe boundaries.
      if (event.key === 'Tab' && parent !== window) {
        const nodes = [
          ...document.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,summary'),
        ].filter((node) => !node.hasAttribute('disabled') && node.getClientRects().length);
        if (
          (event.shiftKey && document.activeElement === nodes[0]) ||
          (!event.shiftKey && document.activeElement === nodes.at(-1))
        ) {
          const frame = window.frameElement;
          const close = frame
            ?.closest('[role=dialog]')
            ?.querySelector<HTMLElement>('[aria-label="閉じる"]');
          if (close) {
            event.preventDefault();
            close.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => {
      active = false;
      window.removeEventListener('keydown', keyboard);
    };
  }, [anchor]);
  return null;
}
