import Link from 'next/link';
import Image from 'next/image';
import { ArrowDown, ArrowRight, ArrowUpRight, Phone } from 'lucide-react';
import SiteShell from '@/components/SiteShell';
import HeroConsult from '@/components/HeroConsult';
import HeroSlider from '@/components/HeroSlider';
import { company, services } from '@/lib/company';
import StructuredData from '@/components/StructuredData';
import { organizationSchema } from '@/lib/seo';
import type { SiteContent } from '@/lib/site-content';

export default function HomePageView({ content }: { content: SiteContent }) {
  const { projects, news, home } = content;
  const legacyHighlights = [
    { src: '/images/legacy/hero-01.jpg', alt: '耐火物製品' },
    { src: '/images/legacy/hero-02.jpg', alt: '大型タンクの積込み' },
    { src: '/images/tank.jpg', alt: '鋼製タンク' },
    { src: '/images/heat-exchanger.jpg', alt: '機械装置' },
    { src: '/images/legacy/hero-03.jpg', alt: '太陽光発電設備' },
  ];
  return (
    <SiteShell>
      <StructuredData data={organizationSchema()} />
      <section className="hero">
        <HeroSlider slides={home.slides} />
        <div className="container hero-inner">
          <div className="hero-copy">
            <p className="eyebrow light">AOKI ENG CO., LTD.</p>
            <h1>
              {home.title}
              <br />
              <em>{home.subtitle}</em>
            </h1>
            <p className="cms-text">{home.lead}</p>
            <div className="hero-actions">
              <Link className="button primary" href="/services">
                事業・サービスを見る <ArrowRight size={18} />
              </Link>
              <Link className="button hero-secondary" href="/projects">
                製作実績を見る <ArrowUpRight size={18} />
              </Link>
            </div>
            <div className="hero-capabilities" aria-label="対応範囲">
              <span>設計</span>
              <i aria-hidden="true" />
              <span>製作</span>
              <i aria-hidden="true" />
              <span>輸送</span>
              <i aria-hidden="true" />
              <span>据付</span>
            </div>
          </div>
          <HeroConsult />
        </div>
        <div className="hero-bottom">
          <a href="#strength">
            SCROLL TO EXPLORE <ArrowDown size={13} />
          </a>
        </div>
      </section>
      {news.length > 0 && (
        <section className="section cms-news" aria-label="お知らせ">
          <div className="container">
            <p className="eyebrow">NEWS</p>
            <h2 className="section-title">お知らせ</h2>
            <div className="cms-news-list">
              {news.map((item) => (
                <article key={item.id}>
                  <time dateTime={item.date}>{item.date.replaceAll('-', '.')}</time>
                  <h3>{item.title}</h3>
                  <p className="cms-text">{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}
      <section className="section legacy-intro" id="strength">
        <div className="container">
          <p className="eyebrow">OUR BUSINESS</p>
          <h2 className="legacy-message cms-text">{home.introduction}</h2>
          <div className="legacy-highlight-grid" aria-label="主な製作・施工実績">
            {legacyHighlights.map((item) => (
              <div className="legacy-highlight" key={item.src}>
                <Image src={item.src} alt={item.alt} fill sizes="180px" />
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="section section-muted">
        <div className="container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">WHAT WE DO</p>
              <h2 className="section-title">事業領域</h2>
            </div>
            <Link className="text-link" href="/services">
              事業・サービスを見る <ArrowUpRight size={18} />
            </Link>
          </div>
          <div className="service-grid">
            {services.map((s, i) => (
              <Link href={`/services/${s.id}`} className="service-card" key={s.id}>
                <div className="service-image">
                  <Image src={s.image} alt={s.name} fill sizes="(max-width: 760px) 50vw, 45vw" />
                </div>
                <div className="service-body">
                  <span className="service-number">
                    0{i + 1} / {s.english}
                  </span>
                  <h3>{s.name}</h3>
                  <p>{s.description}</p>
                  <span className="service-card-link">
                    詳しく見る <ArrowUpRight size={18} />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <section className="section">
        <div className="container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">SELECTED WORKS</p>
              <h2 className="section-title">製作実績</h2>
            </div>
            <Link className="text-link" href="/projects">
              実績一覧を見る <ArrowUpRight size={18} />
            </Link>
          </div>
          <div className="project-feature-grid">
            {projects.slice(0, 3).map((p) => (
              <Link href="/projects" className="project-feature" key={p.id}>
                <div className="project-image">
                  <Image
                    src={p.image}
                    alt={p.name}
                    unoptimized={p.image.startsWith('/api/')}
                    fill
                    sizes="(max-width: 760px) 100vw, 50vw"
                  />
                </div>
                <div className="project-feature-copy">
                  <span>{p.category}</span>
                  <h3>
                    {p.name}
                    <ArrowUpRight size={19} />
                  </h3>
                  <p className="cms-text">{p.description}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <section className="section process-section">
        <div className="container">
          <p className="eyebrow light">CONTACT FLOW</p>
          <h2 className="section-title light">お問い合わせフロー</h2>
          <div className="process-grid">
            {[
              {
                n: '01',
                h: 'ご相談',
                p: '製品名、型番、図面や用途など、わかる範囲でお聞かせください。',
              },
              {
                n: '02',
                h: '確認・ご提案',
                p: '仕様と条件を確認し、担当者が対応方法やお見積りをご案内します。',
              },
              { n: '03', h: '製作・調達', p: '必要な製品を製作・調達し、工程に沿って進めます。' },
              { n: '04', h: '納品・据付', p: '輸送から現地据付まで、案件に応じて対応します。' },
            ].map((s) => (
              <div key={s.n}>
                <span className="process-index">{s.n}</span>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="section section-muted">
        <div className="container consultation-grid">
          <div>
            <p className="eyebrow">FOR YOUR BUSINESS</p>
            <h2>チャット見積システムの導入相談</h2>
            <p>
              Webサイトでの条件整理から、担当者の確認を経た見積発行まで。御社の相談・見積業務に合わせて導入範囲を検討します。
            </p>
            <Link className="text-link" href="/estimate-system">
              仕組みと導入相談を見る →
            </Link>
          </div>
          <div>
            <p className="eyebrow">PRODUCT SOURCING</p>
            <h2>商品・工業用部材を探す</h2>
            <p>
              型番や用途から公開商品を検索できます。特殊な仕様・少量のご希望も、条件を伺って取扱可否を確認します。
            </p>
            <Link className="text-link" href="/products">
              製品を検索・相談する →
            </Link>
          </div>
        </div>
      </section>
      <section className="section contact-band">
        <div className="container contact-band-inner">
          <div className="contact-band-copy">
            <p className="eyebrow">CONTACT</p>
            <h2>まずはご相談下さい</h2>
            <p>製品のお探しものから、製作・施工のご相談まで。</p>
          </div>
          <div className="contact-band-actions">
            <Link className="button primary" href="/contact">
              お問い合わせ <ArrowUpRight size={19} />
            </Link>
            <a className="phone-link" href={`tel:${company.phone}`}>
              <Phone size={20} />
              {company.phone}
            </a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
