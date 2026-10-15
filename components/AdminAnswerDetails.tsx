'use client';
import type { AiAnswer, AiCall } from '@/lib/contracts';
import { CHAT_ROUTE_LABELS } from '@/lib/chat-policy';
import { datetime } from './api';

export const aiProviders = {
  openai: 'OpenAI',
  jev: 'Jev / TypeSafe',
  gemini: 'Gemini',
  local: '登録情報・ルール',
};
export const aiPurposes: Record<AiCall['purpose'], string> = {
  classification: '質問内容の判定',
  response: '回答文の生成',
  research: '商品・価格・納期の調査',
  research_decision: '調査を行うかの判定',
};
export function aiPurpose(call: AiCall) {
  if (call.requestShape.scope === 'product_sourcing') {
    if (call.purpose === 'research') return '商品のWeb検索';
    if (call.purpose === 'research_decision') return '型番と商品の一致判定';
  }
  return aiPurposes[call.purpose];
}
export const aiOutcomes: Record<AiCall['outcome'], string> = {
  pending: '実行中・完了記録なし',
  accepted: '採用',
  rejected: '検証で不採用',
  http_error: 'HTTPエラー',
  network_error: '接続・生成エラー',
};
const responseReasons: Record<string, string> = {
  success_after_retry: '最初の生成文は採用せず、再生成した文章を検証して採用しました。',
  failed_or_ungrounded:
    'AIの生成・検証が完了しなかったため、登録情報・ルールの文章で回答しました。',
  missing_key: '回答用AIの接続キーが未設定のため、登録情報・ルールで回答しました。',
  insufficient_quota: '回答用AIの利用枠が不足しているため、登録情報・ルールで回答しました。',
  estimate: '確認済みの販売条件をもとにアプリで概算を計算して回答しました。',
};
export function answerMethod(answer: AiAnswer) {
  const provider = answer.responseProvider;
  if (!provider) return null;
  if (provider === 'local') return '登録情報・ルールで回答';
  const model =
    answer.processing?.responseModel ||
    answer.calls.find((c) => c.purpose === 'response' && c.outcome === 'accepted')?.model;
  return `${aiProviders[provider]}${model ? ` / ${model}` : ''}${answer.processing?.responseMode === 'mixed' ? ' ＋ 登録情報・ルール' : ''}`;
}
export function AiCallDetails({ call }: { call: AiCall }) {
  return (
    <details className="ai-call-technical">
      <summary>開発者向けの通信詳細</summary>
      {(call.durationMs !== null || call.usage) && (
        <p>
          {[
            call.durationMs !== null ? `${(call.durationMs / 1000).toFixed(2)}秒` : null,
            call.usage
              ? `入力 ${call.usage.inputTokens.toLocaleString()} / 出力 ${call.usage.outputTokens.toLocaleString()} トークン`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <p>
        {call.method} {call.endpoint}
      </p>
      <p>
        HTTP：{call.httpStatus ?? '未取得'} / 送信サイズ：{call.requestBytes.toLocaleString()} bytes
      </p>
      <p>
        開始：{datetime(call.createdAt)} / 完了：
        {call.completedAt ? datetime(call.completedAt) : '完了記録なし'}
      </p>
      {call.usage && (
        <p>
          合計トークン：{call.usage.totalTokens.toLocaleString()} / キャッシュ済み入力：
          {call.usage.cachedInputTokens?.toLocaleString() ?? '未取得'} / 推論：
          {call.usage.reasoningTokens?.toLocaleString() ?? '未取得'}
        </p>
      )}
      {call.errorCode && <p>エラーコード：{call.errorCode}</p>}
      {call.requestId && <p>提供元リクエストID：{call.requestId}</p>}
      <p>呼び出しID：{call.id}</p>
      <pre>{JSON.stringify(call.requestShape, null, 2)}</pre>
    </details>
  );
}
export default function AdminAnswerDetails({
  answer,
  open = false,
}: {
  answer: AiAnswer;
  open?: boolean;
}) {
  const trace = answer.processing;
  const route = CHAT_ROUTE_LABELS[answer.route as keyof typeof CHAT_ROUTE_LABELS];
  const reason = trace && responseReasons[trace.responseReason];
  return (
    <details className="admin-answer-details" open={open || undefined}>
      <summary>この回答のAI・処理詳細</summary>
      {(route || trace) && (
        <dl className="answer-processing-summary">
          {route && (
            <div>
              <dt>回答の経路</dt>
              <dd>{route}</dd>
            </div>
          )}
          {trace && (
            <div>
              <dt>回答までの時間</dt>
              <dd>{(trace.durationMs / 1000).toFixed(2)}秒</dd>
            </div>
          )}
        </dl>
      )}
      {reason && <p>{reason}</p>}
      {answer.calls.length ? (
        <ol className="answer-ai-calls" aria-label="この回答に関連するAI呼び出し">
          {answer.calls.map((call) => (
            <li key={call.id}>
              <strong>{aiPurpose(call)}</strong>
              {['research', 'research_decision'].includes(call.purpose) &&
                call.createdAt > answer.createdAt && <small>回答後の担当者向け処理</small>}
              <p>
                {aiProviders[call.provider]} / {call.model}
              </p>
              <span className={`ai-call-outcome ${call.outcome}`}>{aiOutcomes[call.outcome]}</span>
              <AiCallDetails call={call} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="help">
          {trace && trace.classificationProvider === 'local' && trace.responseProvider === 'local'
            ? 'この回答にAIのAPI呼び出しはありません。'
            : 'この回答に紐づくAPI呼び出しの記録はありません。'}
        </p>
      )}
    </details>
  );
}
