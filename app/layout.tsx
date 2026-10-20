import type { Metadata } from 'next';
import { pageMetadata, siteOrigin } from '@/lib/seo';
import { searchIndexingEnabled } from '@/lib/search-policy';
import Analytics from '@/components/Analytics';
import './globals.css';
export const metadata: Metadata = {
  ...pageMetadata(
    '北九州・福岡の鋼構造物・機械装置の設計・製作・据付',
    '北九州市門司区のアオキエンジ株式会社。鋼構造物・機械装置の設計・製作・輸送・据付、工業炉の耐火材・炉内金物、工業用部材の調達をご相談いただけます。',
    '/',
  ),
  metadataBase: new URL(siteOrigin()),
  verification: { google: process.env.GOOGLE_SITE_VERIFICATION || undefined },
  title: {
    default: '北九州・福岡の鋼構造物・機械装置の設計・製作・据付 | アオキエンジ株式会社',
    template: '%s | アオキエンジ株式会社',
  },
  description:
    '北九州市門司区のアオキエンジ株式会社。鋼構造物・機械装置の設計・製作・輸送・据付、耐火材・工業用部材の調達をご相談ください。',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" data-scroll-behavior="smooth">
      <body>
        {children}
        {searchIndexingEnabled() &&
          process.env.ANALYTICS_ENABLED === 'true' &&
          /^G-[A-Z0-9]+$/.test(process.env.GA_MEASUREMENT_ID || '') && (
            <Analytics measurementId={process.env.GA_MEASUREMENT_ID!} origin={siteOrigin()} />
          )}
      </body>
    </html>
  );
}
