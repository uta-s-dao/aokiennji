import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: {
    default: 'アオキエンジ株式会社 | 鋼構造物・機械装置の設計・製作・据付',
    template: '%s | アオキエンジ株式会社',
  },
  description:
    '鋼構造物・機械装置の設計、製作、据付から工業炉・耐熱材まで。北九州のアオキエンジ株式会社。',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
