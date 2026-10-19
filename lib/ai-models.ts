export const RECOMMENDED_RESPONSE_MODEL = 'gpt-4.1';

// Keep the search/classification models independent of the sales reply model.
export const DEFAULT_RESPONSE_MODELS = {
  openai: 'gpt-4.1',
  gemini: 'gemini-2.5-flash',
};

export const RESPONSE_MODELS = {
  openai: [
    { id: 'gpt-4.1', label: 'GPT-4.1（商品相談）' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra（最高性能）' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol（性能と速度のバランス）' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna（速度・コスト重視）' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini（従来モデル）' },
  ],
  gemini: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }],
  local: [],
};

export function reasoningResponseModel(model: string) {
  return /^gpt-6(?:[.-]|$)/.test(model);
}

export function openaiReplyOptions(model: string) {
  // Reasoning tokens share max_output_tokens with the visible JSON reply.
  return reasoningResponseModel(model)
    ? { max_output_tokens: 6000, reasoning: { effort: 'high' as const } }
    : { max_output_tokens: 900 };
}
