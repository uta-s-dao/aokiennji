import type { MetadataRoute } from 'next';
import { searchIndexingEnabled, siteOrigin } from '@/lib/search-policy';
import { publicPaths } from '@/lib/service-content';
import { publicProducts } from '@/lib/server/business';
export const dynamic = 'force-dynamic';
export default function sitemap(): MetadataRoute.Sitemap {
  if (!searchIndexingEnabled()) return [];
  return [
    ...publicPaths.map((path) => ({ url: `${siteOrigin()}${path === '/' ? '' : path}` })),
    ...publicProducts()
      .filter((p) => p.approved && !p.isDemo)
      .map((p) => ({ url: `${siteOrigin()}/products/${encodeURIComponent(p.id)}` })),
  ];
}
