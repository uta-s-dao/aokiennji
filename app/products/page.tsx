import ProductsPage from '@/components/ProductsPage';
import { pageMetadata } from '@/lib/seo';
import { publicProducts } from '@/lib/server/business';
import { getPublicConfig } from '@/lib/server/public-config';
export const dynamic = 'force-dynamic';
export const metadata = pageMetadata(
  '製品検索・工業用部材の相談',
  '耐熱ガラス・鋳物・工業用部材を商品名や型番から検索。北九州・福岡の法人様の仕様確認・調達相談・見積依頼を承ります。',
  '/products',
);
export default function Page() {
  return <ProductsPage initialProducts={publicProducts()} initialConfig={getPublicConfig()} />;
}
