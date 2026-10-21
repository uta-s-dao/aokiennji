'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Boxes,
  FileText,
  Gauge,
  History,
  Activity,
  LogOut,
  Menu,
  MessageSquareText,
  Package,
  Settings2,
  ShoppingCart,
  Truck,
  X,
} from 'lucide-react';
import { api, errorMessage } from '@/components/api';
import AdminOverview from '@/components/AdminOverview';
import AdminProducts from '@/components/AdminProducts';
import AdminSources from '@/components/AdminSources';
import AdminSuppliers from '@/components/AdminSuppliers';
import AdminConversations from '@/components/AdminConversations';
import AdminQuotes from '@/components/AdminQuotes';
import AdminOrders from '@/components/AdminOrders';
import AdminSettings from '@/components/AdminSettings';
import AdminAudit from '@/components/AdminAudit';
import AdminAiUsage from '@/components/AdminAiUsage';
import AdminBilling from '@/components/AdminBilling';
import AdminNotifications from '@/components/AdminNotifications';
import AdminJobs from '@/components/AdminJobs';
import AdminSiteContent from '@/components/AdminSiteContent';
import type { Overview } from '@/lib/contracts';
const tabs = [
  { id: 'overview', label: '概要', icon: Gauge },
  { id: 'site-content', label: 'サイト編集', icon: FileText },
  { id: 'products', label: '商品', icon: Package },
  { id: 'sources', label: '情報源・取込', icon: Boxes },
  { id: 'suppliers', label: '仕入先', icon: Truck },
  { id: 'conversations', label: '相談・引継ぎ', icon: MessageSquareText },
  { id: 'quotes', label: '見積', icon: FileText },
  { id: 'orders', label: '注文', icon: ShoppingCart },
  { id: 'settings', label: '設定', icon: Settings2 },
  { id: 'ai-usage', label: 'AI利用記録', icon: Activity },
  { id: 'billing', label: '利用枠・お支払い', icon: Gauge },
  { id: 'notifications', label: '受付通知', icon: MessageSquareText },
  { id: 'jobs', label: '定期処理・バックアップ', icon: History },
  { id: 'audit', label: '操作履歴', icon: History },
];
export default function Admin() {
  const router = useRouter(),
    [tab, setTab] = useState('overview'),
    [mobile, setMobile] = useState(false),
    [ready, setReady] = useState(false),
    [authError, setAuthError] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const value = params.get('tab');
    if (value === 'source-verification') {
      params.set('tab', 'conversations');
      history.replaceState(null, '', `/admin?${params}`);
      setTab('conversations');
    }
    if (value && tabs.some((t) => t.id === value)) setTab(value);
    api<Overview>('/api/admin/overview')
      .then(() => setReady(true))
      .catch((e) => {
        if ((e as { status?: number }).status === 401) router.replace('/admin/login');
        else {
          setAuthError(errorMessage(e));
          setReady(true);
        }
      });
  }, [router]);
  function select(id: string) {
    if (!window.dispatchEvent(new Event('aoki:admin-navigate', { cancelable: true }))) return;
    setTab(id);
    setMobile(false);
    history.replaceState(null, '', `/admin?tab=${id}`);
  }
  async function logout() {
    if (!window.dispatchEvent(new Event('aoki:admin-navigate', { cancelable: true }))) return;
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/admin/login');
      router.refresh();
    }
  }
  const active = tabs.find((x) => x.id === tab)!;
  return (
    <div className="admin-app">
      <aside className={`admin-sidebar ${mobile ? 'open' : ''}`}>
        <div className="admin-brand">
          <Link className="brand brand-light" href="/">
            <span className="brand-mark">A</span>
            <span className="brand-words">
              <strong>AOKI ENG</strong>
              <small>管理画面</small>
            </span>
          </Link>
          <button
            type="button"
            className="icon-button admin-mobile-close"
            onClick={() => setMobile(false)}
            aria-label="メニューを閉じる"
          >
            <X />
          </button>
        </div>
        <nav aria-label="管理画面メニュー">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? 'active' : ''}
              onClick={() => select(t.id)}
            >
              <t.icon size={19} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <Link href="/" target="_blank">
            公開サイトを見る ↗
          </Link>
          <button type="button" onClick={logout}>
            <LogOut size={18} /> ログアウト
          </button>
        </div>
      </aside>
      {mobile && (
        <button
          className="admin-scrim"
          aria-label="メニューを閉じる"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="admin-workspace">
        <header className="admin-topbar">
          <button
            type="button"
            className="admin-menu-button icon-button"
            aria-label="管理メニューを開く"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </button>
          <div>
            <span>AOKI ENG / ADMIN</span>
            <strong>{active.label}</strong>
          </div>
          <Link href="/" target="_blank">
            公開サイト ↗
          </Link>
        </header>
        <main className="admin-main">
          <div className="admin-page-title">
            <p className="eyebrow">MANAGEMENT</p>
            <h1>{active.label}</h1>
          </div>
          {!ready ? (
            <div className="state-box">管理画面を読み込んでいます…</div>
          ) : authError ? (
            <div className="state-box error" role="alert">
              {authError}
              <button className="button secondary" onClick={() => location.reload()}>
                再読み込み
              </button>
            </div>
          ) : (
            <>
              {tab === 'overview' && <AdminOverview navigate={select} />}
              {tab === 'site-content' && <AdminSiteContent />}
              {tab === 'products' && <AdminProducts />}
              {tab === 'sources' && <AdminSources />}
              {tab === 'suppliers' && <AdminSuppliers />}
              {tab === 'conversations' && <AdminConversations />}
              {tab === 'quotes' && <AdminQuotes />}
              {tab === 'orders' && <AdminOrders />}
              {tab === 'settings' && <AdminSettings />}
              {tab === 'ai-usage' && <AdminAiUsage />}
              {tab === 'billing' && <AdminBilling />}
              {tab === 'notifications' && <AdminNotifications />}
              {tab === 'jobs' && <AdminJobs />}
              {tab === 'audit' && <AdminAudit />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
