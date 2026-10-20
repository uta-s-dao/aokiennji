'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, CalendarDays } from 'lucide-react';
import type { Product, PublicConfig } from '@/lib/contracts';
import { AVAILABILITY_LABELS } from '@/lib/contracts';
import SiteShell from '@/components/SiteShell';
import { openChat } from '@/components/ChatWidget';
import { api, date, errorMessage, yen } from '@/components/api';
export default function ProductDetail({
  initialProduct,
  initialConfig,
}: {
  initialProduct: Product;
  initialConfig: PublicConfig;
}) {
  const id = initialProduct.id;
  const [product, setProduct] = useState<Product | null>(initialProduct),
    [config, setConfig] = useState<PublicConfig | null>(initialConfig),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    Promise.all([
      api<Product>(`/api/products/${encodeURIComponent(id)}`),
      api<PublicConfig>('/api/config'),
    ])
      .then(([p, c]) => {
        setProduct(p);
        setConfig(c);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [id]);
  return (
    <SiteShell>
      <section className="section product-detail">
        <div className="container">
          <Link className="back-link" href="/products">
            <ArrowLeft size={18} /> 製品一覧へ戻る
          </Link>
          {loading ? (
            <div className="state-box">読み込んでいます…</div>
          ) : error ? (
            <div className="state-box error" role="alert">
              {error}
            </div>
          ) : (
            product && (
              <>
                <div className="detail-header">
                  <div>
                    <p className="eyebrow">PRODUCT DETAIL</p>
                    <span className="pill">{product.category}</span>
                    <h1>{product.name}</h1>
                    <p>
                      {product.manufacturer} {product.model}
                    </p>
                  </div>
                  <div className="detail-status">
                    <span className={`availability ${product.availability}`}>
                      {AVAILABILITY_LABELS[product.availability]}
                    </span>
                    {product.isDemo && <span className="demo-tag">デモ商品</span>}
                  </div>
                </div>
                <div className="detail-layout">
                  <div className="detail-main">
                    <div className="detail-image">
                      {product.image ? (
                        <img src={product.image} alt={product.name} />
                      ) : (
                        <div className="image-placeholder">AOKI ENG</div>
                      )}
                    </div>
                    <h2>製品について</h2>
                    <p className="preline">
                      {product.description || '詳細はお問い合わせください。'}
                    </p>
                    <h2>仕様・用途</h2>
                    <p className="preline">
                      {product.specifications || '仕様はお問い合わせください。'}
                    </p>
                    {product.evidence?.filter((e) => e.visibility === 'public' && e.url).length ? (
                      <div className="evidence-block">
                        <h2>参照情報</h2>
                        {product.evidence
                          ?.filter((e) => e.visibility === 'public' && e.url)
                          .map((e, i) => (
                            <a key={i} href={e.url} target="_blank" rel="noopener noreferrer">
                              {e.title} ↗ <small>確認日 {date(e.retrievedAt)}</small>
                            </a>
                          ))}
                      </div>
                    ) : null}
                  </div>
                  <aside className="detail-aside">
                    <h2>製品情報</h2>
                    <dl>
                      <div>
                        <dt>取扱状態</dt>
                        <dd>{AVAILABILITY_LABELS[product.availability]}</dd>
                      </div>
                      {config?.flags.showPrice && product.price !== null && (
                        <div>
                          <dt>参考価格</dt>
                          <dd>{yen(product.price)}</dd>
                        </div>
                      )}
                      {config?.flags.showStock && product.stock !== null && (
                        <div>
                          <dt>在庫</dt>
                          <dd>{product.stock} 個</dd>
                        </div>
                      )}
                      {config?.flags.showLeadTime && product.leadTime && (
                        <div>
                          <dt>納期目安</dt>
                          <dd>{product.leadTime}</dd>
                        </div>
                      )}
                      <div>
                        <dt>情報確認日</dt>
                        <dd>{date(product.verifiedAt)}</dd>
                      </div>
                    </dl>
                    <p className="aside-note">
                      <CalendarDays size={16} /> 最新の条件は担当者が確認します。
                    </p>
                    {config?.flags.quoteRequests && (
                      <Link
                        className="button primary full"
                        href={`/contact?productId=${encodeURIComponent(product.id)}&subject=${encodeURIComponent(product.name)}&quote=1`}
                      >
                        見積を依頼する <ArrowUpRight size={18} />
                      </Link>
                    )}
                    <button
                      className="button secondary full"
                      type="button"
                      onClick={() =>
                        openChat(`${product.name}（${product.model}）について相談したい`)
                      }
                    >
                      この製品を相談する
                    </button>
                  </aside>
                </div>
              </>
            )
          )}
        </div>
      </section>
    </SiteShell>
  );
}
