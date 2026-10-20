// Shared by Next's metadata and response headers. Indexing requires an explicit
// production opt-in; a preview or demo must never inherit the production setting.
type SearchEnvironment = Record<string, string | undefined>;
export function siteOrigin(env: SearchEnvironment = process.env) {
  const url = new URL(env.SITE_URL || 'https://www.aokieng.co.jp');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('SITE_URL must be a public HTTPS origin without a path or credentials.');
  return url.origin;
}
export function searchIndexingEnabled(env: SearchEnvironment = process.env) {
  return (
    env.NODE_ENV === 'production' &&
    env.SEARCH_INDEXING_ENABLED === 'true' &&
    env.DEMO_MODE === 'false' &&
    (!env.VERCEL_ENV || env.VERCEL_ENV === 'production') &&
    env.APP_ORIGIN === siteOrigin(env)
  );
}
