import handler from 'vinext/server/fetch-handler';
import { createDatabaseScope, type HyperdriveBinding } from './lib/server/database';

export default {
  async fetch(
    request: Request,
    env: Record<string, unknown> & { HYPERDRIVE?: HyperdriveBinding },
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
      const response = await scope.run(() => handler.fetch(request, env, requestContext));
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
