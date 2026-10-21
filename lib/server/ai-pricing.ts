import { ApiError } from './auth';
import { MICRO_YEN } from './billing-config';

export const PRICE_VERSION = '2026-10-21-v1';
// USD per million tokens. Standard text requests only. Unknown models fail closed.
const rates: Record<string, { input: number; cached: number; output: number; context: number }> = {
  'openai:gpt-4.1': { input: 2, cached: 0.5, output: 8, context: 1_047_576 },
  'openai:gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6, context: 1_047_576 },
  'openai:gpt-5-mini': { input: 0.25, cached: 0.025, output: 2, context: 400_000 },
  'gemini:gemini-2.5-flash': { input: 0.3, cached: 0.03, output: 2.5, context: 1_048_576 },
  // Conservative long-context standard rates; GPT-6 web tools require a separate bound.
  'openai:gpt-6-astra': { input: 20, cached: 2, output: 75, context: 0 },
  'openai:gpt-6.1-sol': { input: 4, cached: 0.2, output: 15, context: 0 },
  'openai:gpt-6-sol': { input: 4, cached: 0.4, output: 15, context: 0 },
  'openai:gpt-6-luna': { input: 0.2, cached: 0.02, output: 0.75, context: 0 },
};
export function pricingPolicy() {
  const usdJpy = Number(process.env.AI_BUDGET_USD_JPY || 160);
  const marginPercent = Number(process.env.AI_BUDGET_MARGIN_PERCENT || 25);
  if (
    !Number.isFinite(usdJpy) ||
    usdJpy < 1 ||
    usdJpy > 1000 ||
    !Number.isFinite(marginPercent) ||
    marginPercent < 10 ||
    marginPercent > 200
  )
    throw new ApiError(503, 'pricing_invalid', '料金換算の設定を確認してください。');
  return {
    version: PRICE_VERSION,
    usdJpy,
    marginPercent,
    models: [
      ...Object.keys(rates),
      'exa:auto',
      'tavily:basic',
      ...(process.env.AI_JEV_MAX_CALL_USD && process.env.AI_JEV_PRICE_VERSION
        ? ['jev:contract']
        : []),
    ],
  };
}
export interface PriceQuote {
  version: string;
  usdJpy: number;
  marginPercent: number;
  provider: string;
  model: string;
  inputRate: number;
  cachedRate: number;
  outputRate: number;
  inputBound: number;
  outputBound: number;
  toolBound: number;
  toolUsd: number;
  searchTokensPerCall: number;
  fixedUsd: number;
  reserved: number;
}
export interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
}
function micro(usd: number, q: { usdJpy: number; marginPercent: number }) {
  const result = Math.ceil(usd * q.usdJpy * (1 + q.marginPercent / 100) * MICRO_YEN);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid cost');
  return result;
}
export function quoteCall(provider: string, model: string, bodyText: string): PriceQuote {
  const policy = pricingPolicy();
  const body = JSON.parse(bodyText);
  const q: PriceQuote = {
    ...policy,
    provider,
    model,
    inputRate: 0,
    cachedRate: 0,
    outputRate: 0,
    inputBound: 0,
    outputBound: 0,
    toolBound: 0,
    toolUsd: 0,
    searchTokensPerCall: 0,
    fixedUsd: 0,
    reserved: 0,
  };
  const invalid = () =>
    new ApiError(
      503,
      'price_unregistered',
      'このAPIの料金または最大使用量を確認できません。登録情報の案内・担当者への相談をご利用ください。',
    );
  if (provider === 'exa') {
    if (
      body.type !== 'auto' ||
      body.numResults > 10 ||
      Object.keys(body.contents || {}).some((k) => k !== 'highlights')
    )
      throw invalid();
    q.fixedUsd = 0.007;
  } else if (provider === 'tavily') {
    if (body.search_depth !== 'basic' || body.auto_parameters !== false) throw invalid();
    q.fixedUsd = 0.008;
  } else if (provider === 'jev') {
    const max = Number(process.env.AI_JEV_MAX_CALL_USD);
    if (!Number.isFinite(max) || max <= 0 || max > 10 || !process.env.AI_JEV_PRICE_VERSION)
      throw invalid();
    q.fixedUsd = max;
    q.version += `:jev:${process.env.AI_JEV_PRICE_VERSION}`;
  } else {
    const rate = rates[`${provider}:${model}`];
    if (
      !rate ||
      (body.service_tier && body.service_tier !== 'default') ||
      body.previous_response_id ||
      body.conversation ||
      body.cachedContent ||
      /"type"\s*:\s*"(input_image|input_file|input_audio)"|"inlineData"|"fileData"/.test(bodyText)
    )
      throw invalid();
    const tools = body.tools || [];
    if (
      !Array.isArray(tools) ||
      tools.some((t: { type?: string }) => t.type !== 'web_search') ||
      (tools.length && provider !== 'openai')
    )
      throw invalid();
    const maxOutput =
      provider === 'openai' ? body.max_output_tokens : body.generationConfig?.maxOutputTokens;
    if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0 || maxOutput > 65_536) throw invalid();
    // UTF-8 bytes bound text tokens conservatively, including schema/framing overhead.
    q.inputBound = Buffer.byteLength(bodyText) + 8192;
    // Include Gemini thinking usage by reserving the model's full output ceiling.
    q.outputBound = provider === 'gemini' ? 65_536 : maxOutput;
    if (tools.length) {
      if (!rate.context) throw invalid();
      if (
        !Number.isSafeInteger(body.max_tool_calls) ||
        body.max_tool_calls < 1 ||
        body.max_tool_calls > 5
      )
        throw invalid();
      q.toolBound = body.max_tool_calls;
      q.toolUsd = 0.01;
      q.searchTokensPerCall = model === 'gpt-4.1-mini' ? 8000 : 0;
      // Tool results and repeated model input are bounded by the context per iteration.
      q.inputBound = rate.context * (q.toolBound + 1);
    }
    q.inputRate = rate.input;
    q.cachedRate = rate.cached;
    q.outputRate = rate.output;
  }
  q.reserved = micro(
    q.fixedUsd +
      (q.inputBound * q.inputRate + q.outputBound * q.outputRate) / 1e6 +
      q.toolBound * (q.toolUsd + (q.searchTokensPerCall * q.inputRate) / 1e6),
    q,
  );
  if (!q.reserved) throw invalid();
  return q;
}
export function actualCost(
  q: PriceQuote,
  usage: CostUsage | null,
  tools: number | null,
  httpSuccess: boolean,
): number | null {
  if (!httpSuccess) return null;
  // Jev's configured amount is only an upper bound, not a reported charge.
  if (q.provider === 'jev') return null;
  if (q.fixedUsd) return q.reserved;
  if (!usage || (q.toolBound && tools === null)) return null;
  const cached = usage.cachedInputTokens || 0;
  if (
    cached > usage.inputTokens ||
    usage.inputTokens > q.inputBound ||
    usage.outputTokens > q.outputBound ||
    (tools || 0) > q.toolBound
  )
    return null;
  return micro(
    ((usage.inputTokens - cached) * q.inputRate +
      cached * q.cachedRate +
      usage.outputTokens * q.outputRate +
      (tools || 0) * q.searchTokensPerCall * q.inputRate) /
      1e6 +
      (tools || 0) * q.toolUsd,
    q,
  );
}
