import Link from 'next/link';
import { ArrowUpRight, MapPin, Phone } from 'lucide-react';
import SiteShell from '@/components/SiteShell';
import { company, services } from '@/lib/company';
export default function Profile() {
  const rows = [
    ['社名', company.name],
    ['英文社名', company.englishName],
    ['創立', company.established],
    ['資本金', company.capital],
    ['所在地', `〒${company.postalCode} ${company.address}`],
    ['電話番号', company.phone],
    ['FAX', company.fax],
  ];
  return (
    <SiteShell>
      <div className="page-hero">
        <div className="container">
          <p className="eyebrow">COMPANY</p>
          <h1>会社案内</h1>
          <p>地域の産業とともに、ものづくりを支える。</p>
        </div>
      </div>
      <section className="section">
        <div className="container profile-intro">
          <div className="contact-band-copy">
            <p className="eyebrow">OUR COMPANY</p>
            <h2 className="section-title">
              現場の課題に、
              <br />
              技術で向き合う。
            </h2>
          </div>
          <p className="lead">
            アオキエンジは、鋼構造物と機械装置の設計・製作・据付を中心に、工業炉に関わる部材や施工など幅広いご相談に対応しています。構想から現場まで、ものづくりの一歩先を見据えて取り組みます。
          </p>
        </div>
      </section>
      <section className="section section-muted">
        <div className="container">
          <p className="eyebrow">BUSINESS</p>
          <h2 className="section-title">事業内容</h2>
          <div className="profile-services">
            {services.map((s, i) => (
              <div key={s.id}>
                <span>0{i + 1}</span>
                <h3>{s.name}</h3>
                <p>{s.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="section">
        <div className="container">
          <p className="eyebrow">OVERVIEW</p>
          <h2 className="section-title">会社概要</h2>
          <dl className="detail-table">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="location-panel">
            <MapPin size={28} />
            <div>
              <h3>本社所在地</h3>
              <p>
                〒{company.postalCode} {company.address}
              </p>
              <a
                className="text-link"
                href={company.mapUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                地図を開く <ArrowUpRight size={18} />
              </a>
            </div>
          </div>
        </div>
      </section>
      <section className="section contact-band">
        <div className="container contact-band-inner">
          <div className="contact-band-copy">
            <p className="eyebrow">CONTACT</p>
            <h2>製品・製作のご相談はこちら</h2>
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
