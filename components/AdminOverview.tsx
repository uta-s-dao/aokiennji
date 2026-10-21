'use client';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  FileText,
  MessageSquareText,
  Package,
  ShoppingCart,
} from 'lucide-react';
import type { Overview } from '@/lib/contracts';
import { api, datetime, errorMessage } from './api';
import { Empty, Notice } from './AdminCommon';
export default function AdminOverview({ navigate }: { navigate: (tab: string) => void }) {
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    api<Overview>('/api/admin/overview')
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  if (error)
    return (
      <Empty
        title={error}
        action={
          <button className="button secondary" onClick={() => location.reload()}>
            再読み込み
          </button>
        }
      />
    );
  if (!data) return <div className="state-box">読み込んでいます…</div>;
  const stats = [
    { id: 'products', label: '商品', value: data.products, icon: Package },
    { id: 'sources', label: '情報源', value: data.sources, icon: Boxes },
    { id: 'conversations', label: '相談', value: data.conversations, icon: MessageSquareText },
    { id: 'quotes', label: '見積', value: data.quotes, icon: FileText },
    { id: 'orders', label: '注文', value: data.orders, icon: ShoppingCart },
  ];
  return (
    <>
      <div className="overview-welcome">
        <div>
          <span className="eyebrow">DASHBOARD</span>
          <h2>今日の業務を、ここから。</h2>
          <p>
            {data.demoMode
              ? '現在はデモ運用中です。確認用のデータを扱っています。'
              : '現在の登録・受付状況をご確認ください。'}
          </p>
        </div>
        <button className="button light" onClick={() => navigate('conversations')}>
          相談を確認 <ArrowRight size={18} />
        </button>
      </div>
      {data.openaiQuotaExhaustedAt && (
        <Notice
          type="error"
          message={`OpenAIの利用残高（クレジット）が不足しているため、${datetime(data.openaiQuotaExhaustedAt)}以降、生成AIによる回答と担当者向けのAI調査が止まっています。チャットは登録情報と決まった文で回答を続けています。OpenAIの管理画面でクレジットを追加してください。`}
        />
      )}
      <div className="stat-grid">
        {stats.map((s) => (
          <button type="button" className="stat-card" key={s.id} onClick={() => navigate(s.id)}>
            <s.icon size={22} />
            <span>{s.label}</span>
            <strong>{s.value}</strong>
            <ArrowRight size={16} />
          </button>
        ))}
      </div>
      <section className="admin-card">
        <h2>サイトの運用</h2>
        <p>利用枠、接続状態、定期処理と障害通知をまとめて確認できます。</p>
        <button className="button button-outline" onClick={() => navigate('monitoring')}>
          運用・外部監視を開く <ArrowRight size={16} />
        </button>
      </section>
      <div className="admin-two-col">
        <section className="admin-card">
          <div className="card-title">
            <h2>確認待ち</h2>
          </div>
          <div className="pending-grid">
            <button onClick={() => navigate('conversations')}>
              <strong>{data.pendingInquiries}</strong>
              <span>お問い合わせ</span>
              <ArrowRight size={16} />
            </button>
            <button onClick={() => navigate('orders')}>
              <strong>{data.pendingOrders}</strong>
              <span>注文</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </section>
        <section className="admin-card">
          <div className="card-title">
            <h2>直近の活動</h2>
            <button className="link-button" onClick={() => navigate('audit')}>
              すべて見る →
            </button>
          </div>
          {data.recentEvents.length ? (
            <ul className="activity-list">
              {data.recentEvents.map((e) => (
                <li key={e.id}>
                  <span>{e.summary}</span>
                  <small>{datetime(e.createdAt)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">活動履歴はまだありません。</p>
          )}
        </section>
      </div>
    </>
  );
}
