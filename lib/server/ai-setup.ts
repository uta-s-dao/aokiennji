import { asyncMap } from '@/lib/async-arrays';
import { createHash } from 'node:crypto';
import type { AppSettings, ProviderCheck } from '../contracts';
import { db, getSettings } from './db';
import { classifyQuery, providerStatuses, searchWeb } from './providers';
import { DEFAULT_RESPONSE_MODEL, generateGroundedReply, responseModel } from './ai-responses';

function modelFor(id: string, s: AppSettings) {
  if (id === 'jev') return s.decisionProvider === 'jev' && s.model ? s.model : 'jev-latest';
  if (id === 'gemini' && s.decisionProvider === 'gemini')
    return s.model || DEFAULT_RESPONSE_MODEL.gemini;
  if (id === 'openai' || id === 'gemini')
    return responseModel({
      ...s,
      responseProvider: id,
      responseModel: s.responseProvider === id ? s.responseModel : '',
    });
  return id;
}
function credentialTag(key: string) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        key: process.env[key] || '',
        ...(key === 'TYPESAFE_API_KEY'
          ? { baseURL: process.env.TYPESAFE_API_BASE_URL || 'https://api.typesafe.ai' }
          : {}),
      }),
    )
    .digest('hex');
}
export async function aiProviderStatuses() {
  const s = (await getSettings());
  return (await asyncMap(providerStatuses(), async (p) => {
    const row = (await db()
      .prepare('SELECT value FROM metadata WHERE key=?')
      .get(`provider_check:${p.id}`)) as { value: string } | undefined;
    const saved = row ? JSON.parse(row.value) : undefined;
    const check =
      p.configured &&
      saved?.tag === credentialTag(p.envKey) &&
      saved?.check.model === modelFor(p.id, s)
        ? (saved.check as ProviderCheck)
        : undefined;
    return { ...p, check };
  }));
}
export async function checkAiProvider(id: string): Promise<ProviderCheck> {
  const p = providerStatuses().find((p) => p.id === id);
  if (!p) throw Error('不明な接続先です');
  const s = (await getSettings());
  const model = modelFor(id, s);
  const start = Date.now();
  let ok = false,
    message = `${p.envKey} が未設定です。`;
  if (p.configured) {
    try {
      if (id === 'jev' || (id === 'gemini' && s.decisionProvider === 'gemini')) {
        const result = await classifyQuery(
          '納期は何日ですか？',
          {
            ...s,
            decisionProvider: id as 'jev' | 'gemini',
            model,
          },
          [],
          { usageContext: { scope: 'connection_check' } },
        );
        ok = result.provider === id && result.intent === 'lead_time';
      } else if (id === 'openai' || id === 'gemini') {
        const result = await generateGroundedReply(
          {
            question: 'こんにちは',
            history: [],
            canonical: 'こんにちは。ご相談内容をお聞かせください。',
            facts: [],
            confirmedProduct: false,
            privateText: () => false,
            settings: { ...s, responseProvider: id, responseModel: model },
          },
          { usageContext: { scope: 'connection_check' } },
        );
        ok = result.provider === id;
      } else {
        await searchWeb(
          '工業用部品',
          { ...s, searchProvider: id as 'exa' | 'tavily', flags: { ...s.flags, webSearch: true } },
          [],
          { context: { scope: 'connection_check' } },
        );
        ok = true;
      }
      message = ok
        ? '実際のAPIへの接続と応答形式を確認しました。'
        : '接続または応答検証に失敗しました。キー・モデル名・利用枠を確認してください。';
    } catch {
      message = '接続に失敗しました。キー・利用枠・ネットワークを確認してください。';
    }
  }
  const check = {
    ok,
    checkedAt: new Date().toISOString(),
    model,
    message,
    durationMs: Date.now() - start,
  };
  (await db()
    .prepare(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    )
    .run(`provider_check:${id}`, JSON.stringify({ tag: credentialTag(p.envKey), check })));
  return check;
}
