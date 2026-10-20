import type { MetadataRoute } from 'next';
import { searchIndexingEnabled, siteOrigin } from '@/lib/search-policy';
export const dynamic = 'force-dynamic';
export default function robots(): MetadataRoute.Robots {
  return searchIndexingEnabled()
    ? {
        rules: { userAgent: '*', allow: '/', disallow: ['/api/'] },
        sitemap: `${siteOrigin()}/sitemap.xml`,
      }
    : { rules: { userAgent: '*', disallow: '/' } };
  // Sensitive HTML remains crawlable in production so crawlers can see noindex.
  // robots.txt is not access control; existing session/token checks remain required.
}
