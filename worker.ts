import { runScheduledJobs } from './lib/server/jobs';
import handler from 'vinext/server/fetch-handler';
import { withStaticAssets, type StaticAssetBinding } from './lib/server/runtime-assets';
import { createDatabaseScope, type HyperdriveBinding } from './lib/server/database';

export default {
  async scheduled(
    event: { scheduledTime: number },
    env: Record<string, unknown> & { HYPERDRIVE?: HyperdriveBinding },
    context: { waitUntil(p: Promise<unknown>): void },
  ) {
    // Only Cloudflare invokes this handler. Public HTTP entry uses a separate bearer secret.
    if (env.JOBS_ENABLED !== 'true') return;
    const scope = createDatabaseScope(env.HYPERDRIVE);
    context.waitUntil(
      scope.run(async () => {
        try {
          const results = await runScheduledJobs(event.scheduledTime);
          if (results.some((result) => 'status' in result && result.status === 'failed'))
            throw new Error('Scheduled maintenance failed; see authenticated job history');
          return results;
        } finally {
          await scope.close();
        }
      }),
    );
  },
  async fetch(
    request: Request,
    env: Record<string, unknown> & { HYPERDRIVE?: HyperdriveBinding; ASSETS?: StaticAssetBinding },
    context: { waitUntil(p: Promise<unknown>): void },
  ) {
    const scope = createDatabaseScope(env.HYPERDRIVE);
    const pending = new Set<Promise<unknown>>();
    const requestContext = {
      ...context,
      waitUntil(p: Promise<unknown>) {
        pending.add(p);
        context.waitUntil(p);
      },
    };
    const close = async () => {
      while (pending.size) {
        const batch = [...pending];
        await Promise.allSettled(batch);
        batch.forEach((p) => pending.delete(p));
      }
      await scope.close();
    };
    try {
      const response = await scope.run(() =>
        withStaticAssets(env.ASSETS, () => handler.fetch(request, env, requestContext)),
      );
      if (!response.body) {
        context.waitUntil(close());
        return response;
      }
      const reader = response.body.getReader();
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          context.waitUntil(close());
        }
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              finish();
            } else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            finish();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            finish();
          }
        },
      });
      return new Response(body, response);
    } catch (error) {
      await close();
      throw error;
    }
  },
};
