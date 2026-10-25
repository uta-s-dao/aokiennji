import { z } from 'zod';
import type { AiUsageContext, AppSettings } from '../contracts';
import { responseModel } from './ai-responses';
import { beginAiCall, openaiQuotaPaused, pauseOpenaiForQuota, quotaError } from './ai-usage';
import { safeFetch } from './safe-fetch';

// Selection and intake use structured data. The server, not generated text,
// chooses the stage and writes stock/quotation statements.
export async function salesModel<T>(input: {
  settings: AppSettings;
  model?: string;
  context: AiUsageContext;
  instructions: string;
  data: unknown;
  images?: string[];
  schema: Record<string, unknown>;
  validator: z.ZodType<T>;
  purpose: 'classification' | 'research';
  signal?: AbortSignal;
}): Promise<T> {
  if (!process.env.OPENAI_API_KEY || openaiQuotaPaused()) throw Error('generation_unavailable');
  const model = input.model || responseModel(input.settings);
  const body = JSON.stringify({
    model,
    store: false,
    instructions: input.instructions,
    input: input.images?.length ? [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input.data) }, ...input.images.map((image_url) => ({ type: 'input_image', image_url, detail: 'high' }))] }] : JSON.stringify(input.data),
    max_output_tokens: 4500,
    text: {
      format: { type: 'json_schema', name: 'sales_stage', strict: true, schema: input.schema },
    },
  });
  const usage = (await beginAiCall({
    provider: 'openai',
    model,
    purpose: input.purpose,
    body,
    context: input.context,
    requestShape: { scope: 'staged_sales', format: 'json_schema' },
  }));
  try {
    const response = await safeFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
      timeoutMs: 30000,
      maxBytes: 1000000,
      maxRedirects: 0,
      httpsOnly: true,
      signal: input.signal,
      onResponse: usage.response,
    });
    usage.response(response.status, response.headers);
    const raw = response.body.toString('utf8');
    if (quotaError(raw)) {
      pauseOpenaiForQuota();
      throw Error('insufficient_quota');
    }
    if (response.status !== 200) throw Error('generation_failed');
    const result = JSON.parse(raw);
    usage.usage(result.usage);
    if (result.status && result.status !== 'completed') throw Error('generation_failed');
    const output = (result.output || [])
      .flatMap((m: { content?: { type: string; text?: string }[] }) =>
        (m.content || []).filter((p) => p.type === 'output_text').map((p) => p.text || ''),
      )
      .join('');
    const parsed = input.validator.parse(JSON.parse(output));
    (await usage.finish(true));
    return parsed;
  } catch (error) {
    (await usage.finish(false, error));
    throw error;
  }
}
