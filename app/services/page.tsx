import Link from 'next/link';
import Image from 'next/image';
import SiteShell from '@/components/SiteShell';
import Breadcrumbs from '@/components/Breadcrumbs';
import ConsultationLinks from '@/components/ConsultationLinks';
import { services } from '@/lib/company';
import { serviceDetails } from '@/lib/service-content';
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata(
  '北九州・福岡の製作・設備工事・部材調達',
  '鋼構造物・機械装置の設計製作、機械設備の据付、耐火材・炉内金物、工業用部材の調達。北九州・福岡の法人様のご相談を承ります。',
  '/services',
);
export default function Services() {
  return (
    <SiteShell>
      <Breadcrumbs
        items={[
          { name: 'ホーム', path: '/' },
          { name: '事業・サービス', path: '/services' },
        ]}
      />
      <div className="page-hero">
        <div className="container">
          <p className="eyebrow">SERVICES</p>
          <h1>北九州・福岡の製作・設備工事のご相談</h1>
          <p>設計から製作・据付、必要な部材の調達まで。用途と現場条件からご相談いただけます。</p>
        </div>
      </div>
      <section className="section">
        <div className="container">
          <div className="service-grid">
            {serviceDetails.map((detail) => {
              const service = services.find((s) => s.id === detail.id)!;
              return (
                <Link className="service-card" href={`/services/${detail.id}`} key={detail.id}>
                  <div className="service-image">
                    <Image
                      src={service.image}
                      alt={service.name}
                      fill
                      sizes="(max-width: 760px) 100vw, 50vw"
                    />
                  </div>
                  <div className="service-body">
                    <h2>{detail.title}</h2>
                    <p>{detail.intro}</p>
                    <span className="text-link">対応内容・相談の準備を見る →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </section>
      <section className="section section-muted">
        <div className="container narrow prose">
          <h2>北九州市門司区から、ご相談を承ります</h2>
          <p>
            北九州・福岡の工場や事業所の設備・部材について、まずは用途やお困りごとをお聞かせください。工事場所、搬入条件、数量、ご希望時期を確認し、対応可否と進め方を担当者がご案内します。
          </p>
          <ConsultationLinks subject="製作・設備工事" />
        </div>
      </section>
    </SiteShell>
  );
}
