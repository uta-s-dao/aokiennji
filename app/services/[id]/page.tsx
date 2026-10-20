import { notFound } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import SiteShell from '@/components/SiteShell';
import Breadcrumbs from '@/components/Breadcrumbs';
import StructuredData from '@/components/StructuredData';
import ConsultationLinks from '@/components/ConsultationLinks';
import { serviceDetails } from '@/lib/service-content';
import { projects } from '@/lib/company';
import { pageMetadata, siteOrigin } from '@/lib/seo';
type Props = { params: Promise<{ id: string }> };
export function generateStaticParams() {
  return serviceDetails.map((s) => ({ id: s.id }));
}
export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const service = serviceDetails.find((s) => s.id === id);
  return service
    ? pageMetadata(`${service.title}｜北九州・福岡`, service.description, `/services/${id}`)
    : {};
}
export default async function Service({ params }: Props) {
  const { id } = await params;
  const service = serviceDetails.find((s) => s.id === id);
  if (!service) notFound();
  const related = projects.filter((p) => (service.projectIds as readonly string[]).includes(p.id));
  return (
    <SiteShell>
      <Breadcrumbs
        items={[
          { name: 'ホーム', path: '/' },
          { name: '事業・サービス', path: '/services' },
          { name: service.title, path: `/services/${id}` },
        ]}
      />
      <StructuredData
        data={{
          '@context': 'https://schema.org',
          '@type': 'Service',
          name: service.title,
          description: service.intro,
          url: `${siteOrigin()}/services/${id}`,
          provider: { '@id': `${siteOrigin()}/#organization` },
        }}
      />
      <div className="page-hero">
        <div className="container">
          <p className="eyebrow">ENGINEERING & SUPPLY</p>
          <h1>{service.title}</h1>
          <p>北九州・福岡の法人様のご相談窓口</p>
        </div>
      </div>
      <section className="section">
        <div className="container narrow prose">
          <p className="lead">{service.intro}</p>
          <h2>ご相談いただける内容</h2>
          <ul>
            {service.examples.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <h2>相談時に分かると進めやすい情報</h2>
          <ul>
            {service.preparation.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p>
            すべてそろっていなくてもお問い合わせいただけます。対応可否・費用・納期は条件確認後にご案内します。
          </p>
          <ConsultationLinks subject={service.title} chat={id === 'materials'} />
        </div>
      </section>
      {related.length > 0 && (
        <section className="section section-muted">
          <div className="container">
            <h2 className="section-title">関連する製作・施工実績</h2>
            <div className="project-grid">
              {related.map((p) => (
                <article className="project-card" key={p.id}>
                  <div className="project-image">
                    <Image src={p.image} alt={p.name} fill sizes="(max-width: 760px) 100vw, 50vw" />
                  </div>
                  <div className="project-content">
                    <h3>{p.name}</h3>
                    <p>{p.description}</p>
                    <Link
                      className="text-link"
                      href={`/contact?subject=${encodeURIComponent(p.name)}`}
                    >
                      類似案件を相談する →
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}
      <section className="section">
        <div className="container narrow prose">
          <h2>よくあるご質問</h2>
          <div className="service-faq">
            {service.faqs.map((faq) => (
              <details key={faq.question}>
                <summary>{faq.question}</summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
          <h2>ご相談から見積まで</h2>
          <ol>
            <li>用途やご希望の条件をお問い合わせください。</li>
            <li>担当者が仕様・施工範囲・調達条件を確認します。</li>
            <li>確認した条件をもとに、お見積りと進め方をご案内します。</li>
          </ol>
          <ConsultationLinks subject={service.title} />
          <Link className="text-link" href="/services">
            ほかの事業・サービスを見る →
          </Link>
        </div>
      </section>
    </SiteShell>
  );
}
