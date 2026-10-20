import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface StaticAssetBinding {
  fetch(request: Request): Promise<Response>;
}
const bindings = new AsyncLocalStorage<StaticAssetBinding | undefined>();
export function withStaticAssets<T>(binding: StaticAssetBinding | undefined, body: () => T): T {
  return bindings.run(binding, body);
}
export async function staticImageExists(path: string) {
  const assets = bindings.getStore();
  if (!assets) return existsSync(join(process.cwd(), 'public', path));
  // This is the platform's static-assets binding, never an external HTTP request.
  const response = await assets.fetch(
    new Request(`https://assets.internal${path}`, { method: 'HEAD' }),
  );
  return response.ok && !!response.headers.get('content-type')?.startsWith('image/');
}
