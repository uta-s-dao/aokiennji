'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Search } from 'lucide-react';
import type { Product, PublicConfig } from '@/lib/contracts';
import { AVAILABILITY_LABELS } from '@/lib/contracts';
import { services } from '@/lib/company';
import { api, errorMessage, yen } from '@/components/api';
import SiteShell from '@/components/SiteShell';
import { openChat } from '@/components/ChatWidget';
export default function Products({
  initialProducts,
  initialConfig,
}: {
  initialProducts: Product[];
  initialConfig: PublicConfig;
}) {
  const [all, setAll] = useState<Product[]>(initialProducts),
    [query, setQuery] = useState(''),
    [category, setCategory] = useState('すべて'),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [config, setConfig] = useState<PublicConfig | null>(initialConfig);
  useEffect(() => {
    Promise.all([api<Product[]>('/api/products'), api<PublicConfig>('/api/config')])
      .then(([p, c]) => {
        setAll(p);
        setConfig(c);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);
  const categories = ['すべて', ...Array.from(new Set(all.map((p) => p.category).filter(Boolean)))];
  const filtered = all.filter(
    (p) =>
      (category === 'すべて' || p.category === category) &&
      `${p.name} ${p.model} ${p.manufacturer} ${p.description} ${p.specifications}`
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s-]/g, '')
        .includes(query.normalize('NFKC').toLowerCase().replace(/[\s-]/g, '')),
  );
  return (
    <SiteShell>
      <div className="page-hero">
        <div className="container">
          <p className="eyebrow">PRODUCTS & SERVICES</p>
          <h1>製品・サービス</h1>
          <p>製品選定から製作・据付まで。お探しのものをご相談ください。</p>
        </div>
      </div>
      <section className="section">
        <div className="container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">OUR SERVICES</p>
              <h2 className="section-title">対応領域</h2>
            </div>
          </div>
          <div className="category-grid">
            {services.map((s) => (
              <button
                type="button"
                onClick={() => openChat(`${s.name}について相談したい`)}
                key={s.id}
              >
                <img src={s.image} alt="" />
                <span>{s.name}</span>
                <ArrowUpRight size={18} />
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="section section-muted" id="catalog">
        <div className="container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">PRODUCT SEARCH</p>
              <h2 className="section-title">製品を探す</h2>
            </div>
          </div>
          <div className="product-search">
            <Search size={21} />
            <input
              aria-label="商品名・型番で検索"
              placeholder="商品名・型番・メーカーで検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="filter-pills" role="group" aria-label="商品カテゴリ">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className={c === category ? 'active' : ''}
                aria-pressed={c === category}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
          {loading ? (
            <div className="state-box">商品を読み込んでいます…</div>
          ) : error ? (
            <div className="state-box error" role="alert">
              {error}
              <button className="button secondary" type="button" onClick={() => location.reload()}>
                再読み込み
              </button>
            </div>
          ) : filtered.length ? (
            <div className="product-grid">
              {filtered.map((p) => (
                <article className="product-card" key={p.id}>
                  <div className="product-card-top">
                    <span className="pill">{p.category || '製品'}</span>
                    {p.isDemo && <span className="demo-tag">デモ商品</span>}
                  </div>
                  <div className="product-card-image">
                    {p.image ? (
                      <img src={p.image} alt={p.name} />
                    ) : (
                      <div className="image-placeholder">AOKI ENG</div>
                    )}
                  </div>
                  <div className="product-card-body">
                    <p className="product-model">
                      {p.manufacturer} {p.model}
                    </p>
                    <h3>{p.name}</h3>
                    <p>{p.description}</p>
                    <div className="product-meta">
                      <span className={`availability ${p.availability}`}>
                        {AVAILABILITY_LABELS[p.availability]}
                      </span>
                      {config?.flags.showPrice && p.price !== null && (
                        <strong>{yen(p.price)}</strong>
                      )}
                    </div>
                    <Link className="text-link" href={`/products/${p.id}`}>
                      詳細を見る <ArrowUpRight size={17} />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="state-box">
              <h3>
                {all.length ? '該当する製品が見つかりませんでした' : '現在公開中の製品はありません'}
              </h3>
              <p>型番や名称を変えて検索するか、担当者へ直接ご相談ください。</p>
              <button
                className="button primary"
                type="button"
                onClick={() => openChat(query || '製品を探しています')}
              >
                製品について相談する <ArrowUpRight size={18} />
              </button>
            </div>
          )}
        </div>
      </section>
    </SiteShell>
  );
}
