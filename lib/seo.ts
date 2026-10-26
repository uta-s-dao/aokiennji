import type { Metadata } from 'next';
import { company } from '@/lib/company';
import { searchIndexingEnabled, siteOrigin } from '@/lib/search-policy';
export { searchIndexingEnabled, siteOrigin };
export const privateRobots: Metadata['robots'] = { index: false, follow: false, nocache: true };
export function pageMetadata(
  title: string,
  description: string,
  path: string,
  indexable = true,
): Metadata {
  const url = `${siteOrigin()}${path === '/' ? '' : path}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots:
      indexable && searchIndexingEnabled()
        ? {
            index: true,
            follow: true,
            googleBot: { index: true, follow: true, 'max-image-preview': 'large' },
          }
        : privateRobots,
    openGraph: {
      type: 'website',
      locale: 'ja_JP',
      siteName: company.name,
      title,
      description,
      url,
      images: [
        {
          url: `${siteOrigin()}/images/brand/company-share.png`,
          width: 1200,
          height: 630,
          type: 'image/png',
          alt: 'アオキエンジ株式会社 | 鋼構造物・機械装置の設計・製作・据付',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [
        { url: `${siteOrigin()}/images/brand/company-share.png`, alt: 'アオキエンジ株式会社' },
      ],
    },
  };
}
export function organizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${siteOrigin()}/#organization`,
    name: company.name,
    alternateName: company.englishName,
    url: siteOrigin(),
    logo: `${siteOrigin()}/icon.png`,
    image: `${siteOrigin()}/images/brand/company-share.png`,
    telephone: '+81-93-382-2110',
    faxNumber: '+81-93-382-2175',
    address: {
      '@type': 'PostalAddress',
      postalCode: company.postalCode,
      addressRegion: '福岡県',
      addressLocality: '北九州市門司区',
      streetAddress: '原町別院1番26号',
      addressCountry: 'JP',
    },
  };
}
