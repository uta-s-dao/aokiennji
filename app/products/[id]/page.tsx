import { cache } from 'react';
import { notFound } from 'next/navigation';
import ProductDetailPage from '@/components/ProductDetailPage';
import StructuredData from '@/components/StructuredData';
import { getPublicProduct } from '@/lib/server/business';
import { getPublicConfig } from '@/lib/server/public-config';
import { ApiError } from '@/lib/server/auth';
import { pageMetadata, siteOrigin } from '@/lib/seo';
export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ id: string }> };
const productById = cache(async (id: string) => {
  try {
    return (await getPublicProduct(id));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
});
export async function generateMetadata({ params }: Props) {
  const product = (await productById((await params).id));
  return pageMetadata(
    `${product.name} ${product.model}`,
    product.description || `${product.name}の仕様と調達についてご相談ください。`,
    `/products/${encodeURIComponent(product.id)}`,
    product.approved && !product.isDemo,
  );
}
export default async function Page({ params }: Props) {
  const product = (await productById((await params).id));
  return (
    <>
      {product.approved && !product.isDemo && (
        <StructuredData
          data={{
            '@context': 'https://schema.org',
            '@type': 'Product',
            name: product.name,
            model: product.model,
            description: product.description,
            ...(product.manufacturer
              ? { brand: { '@type': 'Brand', name: product.manufacturer } }
              : {}),
            url: `${siteOrigin()}/products/${encodeURIComponent(product.id)}`,
          }}
        />
      )}
      <ProductDetailPage
        key={product.id}
        initialProduct={product}
        initialConfig={(await getPublicConfig())}
      />
    </>
  );
}
