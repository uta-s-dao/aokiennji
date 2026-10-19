import Link from 'next/link';
import Image from 'next/image';
import { ArrowDown, ArrowRight, ArrowUpRight, Phone } from 'lucide-react';
import SiteShell from '@/components/SiteShell';
import HeroConsult from '@/components/HeroConsult';
import HeroSlider from '@/components/HeroSlider';
import { company, projects, services } from '@/lib/company';
export default function Home() {
  const legacyHighlights = [
    { src: '/images/legacy/hero-01.jpg', alt: '耐火物製品' },
    { src: '/images/legacy/hero-02.jpg', alt: '大型タンクの積込み' },
    { src: '/images/tank.jpg', alt: '鋼製タンク' },
    { src: '/images/heat-exchanger.jpg', alt: '機械装置' },
    { src: '/images/legacy/hero-03.jpg', alt: '太陽光発電設備' },
  ];
  return (
    <SiteShell>
      <section className="hero">
        <HeroSlider />
        <div className="container hero-inner">
          <div className="hero-copy">
            <p className="eyebrow light">AOKI ENG CO., LTD.</p>
            <h1>
              鋼構造物・機械装置の
              <br />
              <em>設計・製作・据付</em>
            </h1>
            <p>
              耐火物製品、工業炉部材、設備工事まで。
              <br />
              長年の経験と技術で、幅広いご要望に対応いたします。
            </p>
            <div className="hero-actions">
              <Link className="button primary" href="/products">
                製品・サービスを見る <ArrowRight size={18} />
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
      <section className="section legacy-intro" id="strength">
        <div className="container">
          <p className="eyebrow">OUR BUSINESS</p>
          <h2 className="legacy-message">
            耐火物製品製造の受注から出荷までの全行程を一括管理。
            <br />
            長年の経験で培ったノウハウを駆使し、様々な製品・構造物に対応いたします。
          </h2>
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
            <Link className="text-link" href="/products">
              製品・サービスを見る <ArrowUpRight size={18} />
            </Link>
          </div>
          <div className="service-grid">
            {services.map((s, i) => (
              <Link href="/products" className="service-card" key={s.id}>
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
                  <Image src={p.image} alt={p.name} fill sizes="(max-width: 760px) 100vw, 50vw" />
                </div>
                <div className="project-feature-copy">
                  <span>{p.category}</span>
                  <h3>
                    {p.name}
                    <ArrowUpRight size={19} />
                  </h3>
                  <p>{p.description}</p>
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
