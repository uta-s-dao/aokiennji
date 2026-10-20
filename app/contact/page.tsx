import ContactPage from '@/components/ContactPage';
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata(
  '製作・工事・商品調達のお問い合わせ',
  '北九州・福岡の製作・設備工事、商品調達、チャット見積システムの導入をご相談ください。アオキエンジ株式会社のお問い合わせ窓口。',
  '/contact',
);
export default function Page() {
  return <ContactPage />;
}
