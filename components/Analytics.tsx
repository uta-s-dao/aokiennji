'use client';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { analyticsPath } from '@/lib/analytics';
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}
const consentKey = 'aoki-analytics-consent-v1';
export default function Analytics({
  measurementId,
  origin,
}: {
  measurementId: string;
  origin: string;
}) {
  const pathname = usePathname();
  const path = analyticsPath(pathname);
  const [consent, setConsent] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    (window as unknown as Record<string, unknown>)[`ga-disable-${measurementId}`] =
      !consent || !path;
    return () => {
      (window as unknown as Record<string, unknown>)[`ga-disable-${measurementId}`] = true;
    };
  }, [consent, path, measurementId]);
  useEffect(() => {
    try {
      setConsent(localStorage.getItem(consentKey) === 'granted');
    } catch {
      /* Default off. */
    }
  }, []);
  useEffect(() => {
    if (!consent || !ready || !path) return;
    const location = origin + (path === '/' ? '' : path);
    // Never send query strings, form contents, chat text, tokens or receipt IDs.
    const context = { page_location: location, page_referrer: '', page_title: path };
    window.gtag?.('set', context);
    window.gtag?.('event', 'page_view', context);
    const conversion = (event: Event) => {
      const { name, leadType } = (event as CustomEvent).detail || {};
      if (
        !['generate_lead', 'chat_open'].includes(name) ||
        !['inquiry', 'quote', 'chat'].includes(leadType)
      )
        return;
      window.gtag?.('event', name, { ...context, lead_type: leadType });
    };
    const click = (event: MouseEvent) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest('a') : null;
      if (link?.getAttribute('href')?.startsWith('tel:'))
        window.gtag?.('event', 'contact_click', { ...context, contact_method: 'phone' });
    };
    window.addEventListener('aoki:conversion', conversion);
    document.addEventListener('click', click);
    return () => {
      window.removeEventListener('aoki:conversion', conversion);
      document.removeEventListener('click', click);
    };
  }, [consent, ready, path, origin]);
  function toggle() {
    const next = !consent;
    if (!next) {
      window.gtag?.('consent', 'update', {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      });
      // GA's own cookies may be scoped either to this host or a parent domain.
      const domains = [
        '',
        ...window.location.hostname.split('.').map((_, i, parts) => '.' + parts.slice(i).join('.')),
      ];
      for (const cookie of document.cookie.split(';')) {
        const name = cookie.trim().split('=')[0];
        if (name === '_ga' || name.startsWith('_ga_'))
          for (const domain of domains)
            document.cookie = `${name}=; Max-Age=0; Path=/;${domain ? ` Domain=${domain};` : ''}`;
      }
    } else if (ready)
      window.gtag?.('consent', 'update', {
        analytics_storage: 'granted',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      });
    setConsent(next);
    try {
      localStorage.setItem(consentKey, next ? 'granted' : 'denied');
    } catch {
      /* This visit only. */
    }
  }
  // This component is outside SiteShell; exclude private routes before loading.
  if (!path) return null;
  return (
    <>
      <div className="analytics-preference">
        <span>利用状況の分析：{consent ? '許可' : '停止'}</span>
        <button type="button" onClick={toggle}>
          {consent ? '分析への同意を取り消す' : '分析に同意する'}
        </button>
        <a href="/privacy">利用目的</a>
      </div>
      {consent && (
        <Script
          id="aoki-ga4"
          src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
          strategy="afterInteractive"
          onReady={() => {
            window.dataLayer = window.dataLayer || [];
            window.gtag = function () {
              window.dataLayer!.push(arguments);
            };
            window.gtag('consent', 'default', {
              analytics_storage: 'granted',
              ad_storage: 'denied',
              ad_user_data: 'denied',
              ad_personalization: 'denied',
            });
            window.gtag('js', new Date());
            window.gtag('config', measurementId, {
              send_page_view: false,
              allow_google_signals: false,
              allow_ad_personalization_signals: false,
              ignore_referrer: true,
              page_location: origin + (path === '/' ? '' : path),
              page_referrer: '',
            });
            setReady(true);
          }}
        />
      )}
    </>
  );
}
