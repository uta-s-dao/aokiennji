import { describe, it, expect } from 'vitest';
import { searchIndexingEnabled, siteOrigin } from '../lib/search-policy';
import { analyticsPath } from '../lib/analytics';
const production = {
  NODE_ENV: 'production',
  SEARCH_INDEXING_ENABLED: 'true',
  DEMO_MODE: 'false',
  APP_ORIGIN: 'https://www.aokieng.co.jp',
  SITE_URL: 'https://www.aokieng.co.jp',
};
describe('public search and measurement boundaries', () => {
  it('requires explicit production, real data and the canonical deployment', () => {
    expect(searchIndexingEnabled(production)).toBe(true);
    for (const override of [
      { NODE_ENV: 'development' },
      { SEARCH_INDEXING_ENABLED: undefined },
      { DEMO_MODE: 'true' },
      { DEMO_MODE: undefined },
      { VERCEL_ENV: 'preview' },
      { APP_ORIGIN: 'https://preview.example.com' },
      { APP_ORIGIN: undefined },
    ])
      expect(searchIndexingEnabled({ ...production, ...override })).toBe(false);
    expect(searchIndexingEnabled({ ...production, VERCEL_ENV: 'production' })).toBe(true);
  });
  it('rejects origins that could produce broken or credential-bearing metadata', () => {
    for (const value of [
      'http://example.com',
      'https://user:secret@example.com',
      'https://example.com/private',
      'https://example.com?token=secret',
    ]) {
      expect(() => siteOrigin({ SITE_URL: value })).toThrow();
    }
  });
  it('never measures private routes or passes query strings through', () => {
    for (const path of [
      '/admin',
      '/admin/login',
      '/quotes/secret-token',
      '/api/chat/private',
      '/contact?email=private@example.com',
    ])
      expect(analyticsPath(path)).toBeNull();
    expect(analyticsPath('/contact')).toBe('/contact');
    expect(analyticsPath('/products/public-product')).toBe('/products/item');
  });
});
