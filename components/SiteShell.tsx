'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, Menu, Phone, X } from 'lucide-react';
import { useState } from 'react';
import { company } from '@/lib/company';
import ChatWidget, { type ChatViewState } from './ChatWidget';
import type { PublicConfig } from '@/lib/contracts';
import { api } from './api';
import { useEffect } from 'react';

const nav = [
  { href: '/products', label: '製品・サービス' },
  { href: '/projects', label: '製作実績' },
  { href: '/profile', label: '会社案内' },
  { href: '/contact', label: 'お問い合わせ' },
];
export default function SiteShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const [chatState, setChatState] = useState<ChatViewState>({ open: false, modal: false });
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => {
    api<PublicConfig>('/api/config')
      .then(setConfig)
      .catch(() => {});
  }, []);
  return (
    <>
      <a className="skip-link" href="#main-content">
        本文へ移動
      </a>
      <div
        className={`site-content${chatState.open ? ' chat-is-open' : ''}`}
        inert={chatState.modal}
      >
        <header className="site-header">
          <div className="container header-inner">
            <Link
              className="brand"
              href="/"
              onClick={() => setMenu(false)}
              aria-label="アオキエンジ ホーム"
            >
              <span className="legacy-brand-logo" aria-hidden="true" />
              <span className="sr-only">アオキエンジ株式会社</span>
            </Link>
            <nav className={`main-nav ${menu ? 'is-open' : ''}`} aria-label="メインナビゲーション">
              {nav.map((n) => (
                <Link
                  href={n.href}
                  onClick={() => setMenu(false)}
                  aria-current={path === n.href ? 'page' : undefined}
                  key={n.href}
                >
                  {n.label}
                </Link>
              ))}
              <Link className="nav-contact" href="/contact" onClick={() => setMenu(false)}>
                ご相談はこちら <ArrowUpRight size={16} />
              </Link>
            </nav>
            <button
              className="mobile-menu icon-button"
              type="button"
              onClick={() => setMenu(!menu)}
              aria-label={menu ? 'メニューを閉じる' : 'メニューを開く'}
              aria-expanded={menu}
            >
              {menu ? <X /> : <Menu />}
            </button>
          </div>
        </header>
        {menu && (
          <button
            className="mobile-nav-scrim"
            type="button"
            aria-label="メニューを閉じる"
            onClick={() => setMenu(false)}
          />
        )}
        {config?.demoMode && (
          <div className="demo-banner">デモ環境：商品・価格・注文は確認用です</div>
        )}
        <main id="main-content">{children}</main>
        <footer className="site-footer">
          <div className="container footer-grid">
            <div>
              <Link className="brand brand-light" href="/">
                <span className="legacy-brand-logo" aria-hidden="true" />
                <span className="sr-only">アオキエンジ株式会社</span>
              </Link>
              <p>
                鋼構造物及び機械装置の設計・製作・据付。
                <br />
                耐火物製品から設備工事まで対応いたします。
              </p>
            </div>
            <div>
              <h3>お問い合わせ</h3>
              <p>
                〒{company.postalCode}
                <br />
                {company.address}
              </p>
              <a className="footer-phone" href={`tel:${company.phone}`}>
                <Phone size={18} />
                {company.phone}
              </a>
            </div>
            <div>
              <h3>サイトマップ</h3>
              {nav.map((n) => (
                <Link href={n.href} key={n.href}>
                  {n.label}
                </Link>
              ))}
              <Link href="/privacy">プライバシー</Link>
              <Link href="/admin/login">管理画面</Link>
            </div>
          </div>
          <div className="container footer-bottom">
            <span>© {new Date().getFullYear()} AOKI ENG CO., LTD.</span>
            <span>FUKUOKA / JAPAN</span>
          </div>
        </footer>
      </div>
      <ChatWidget config={config} onStateChange={setChatState} />
    </>
  );
}
