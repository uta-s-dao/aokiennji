'use client';
import { useEffect, useState } from 'react';
import type { AiAnswerReport, AiUsageReport } from '@/lib/contracts';
import { api, datetime, errorMessage, localDateTime } from './api';
import { Empty, Notice } from './AdminCommon';
import { ConversationDetail } from './AdminConversations';
import AdminAnswerDetails, {
  AiCallDetails,
  aiOutcomes,
  aiProviders,
  aiPurpose,
  answerMethod,
} from './AdminAnswerDetails';

export default function AdminAiUsage() {
  const [answers, setAnswers] = useState<AiAnswerReport | null>(null);
  const [usage, setUsage] = useState<AiUsageReport | null>(null);
  const [provider, setProvider] = useState('');
  const [scope, setScope] = useState('chat');
  const [period, setPeriod] = useState('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [detail, setDetail] = useState<{ conversationId: string; answerId: string } | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ limit: '500' });
    if (provider && provider !== 'local') query.set('provider', provider);
    if (period !== 'all')
      query.set('since', new Date(Date.now() - Number(period) * 86400000).toISOString());
    const answerQuery = new URLSearchParams(query);
    if (provider === 'local') answerQuery.set('provider', 'local');
    query.set('scope', scope);
    Promise.all([
      scope === 'chat'
        ? api<AiAnswerReport>(`/api/admin/ai-answers?${answerQuery}`)
        : Promise.resolve(null),
      provider === 'local'
        ? Promise.resolve(null)
        : api<AiUsageReport>(`/api/admin/ai-usage?${query}`),
    ])
      .then(([answerData, usageData]) => {
        if (active) {
          setAnswers(answerData);
          setUsage(usageData);
        }
      })
      .catch((e) => {
        if (active) {
          setAnswers(null);
          setUsage(null);
          setError(errorMessage(e));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [provider, scope, period, refresh]);
  function download() {
    const records = scope === 'chat' ? { answers, usage } : { usage };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `ai-answers-${localDateTime(new Date().toISOString()).slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <Notice message={error} type="error" />
      <section className="admin-card">
        <h2>回答ごとのAI利用記録</h2>
        <p>
          回答ごとに、AIの用途・モデル・結果を確認できます。調達候補は「会話と回答を確認」の調査メモに表示します。
        </p>
        <p className="help">AIを使わずに返した回答も含みます。記録のない処理項目は省略します。</p>
      </section>
      <div className="admin-toolbar ai-usage-filters">
        <label>
          AI・回答方法
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            aria-label="APIで絞り込み"
          >
            <option value="">すべて</option>
            <option value="openai">OpenAI</option>
            <option value="jev">Jev / TypeSafe</option>
            <option value="gemini">Gemini</option>
            {scope === 'chat' && <option value="local">登録情報・ルールで回答</option>}
          </select>
        </label>
        <label>
          用途
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              if (provider === 'local') setProvider('');
            }}
            aria-label="用途で絞り込み"
          >
            <option value="chat">お客様への回答</option>
            <option value="connection_check">接続確認</option>
            <option value="standalone">その他のAPI処理</option>
          </select>
        </label>
        <label>
          期間
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            aria-label="期間で絞り込み"
          >
            <option value="all">記録開始から</option>
            <option value="1">直近24時間</option>
            <option value="7">直近7日間</option>
            <option value="30">直近30日間</option>
          </select>
        </label>
        <button
          type="button"
          className="button secondary"
          onClick={() => setRefresh((n) => n + 1)}
          disabled={loading}
        >
          再読み込み
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={download}
          disabled={loading || (!answers && !usage)}
        >
          表示中の記録をJSON保存
        </button>
      </div>
      {loading ? (
        <div className="state-box" role="status">
          利用記録を読み込んでいます…
        </div>
      ) : (
        <>
          {answers && (
            <section className="admin-card">
              <h2>お客様へ返した回答</h2>
              <p className="help">
                条件に一致する{answers.total}件のうち、最新{answers.items.length}
                件を表示しています（最大500件）。AIで絞り込むと、回答の準備や調査で使用したもの、不採用になった呼び出しも含みます。
              </p>
              {answers.items.length ? (
                <div className="ai-answer-list">
                  {answers.items.map((answer) => (
                    <article className="ai-answer-card" key={answer.id} aria-label="回答の利用記録">
                      <time dateTime={answer.createdAt}>{datetime(answer.createdAt)}</time>
                      <p className="ai-answer-content">{answer.content}</p>
                      {answerMethod(answer) && (
                        <p className="admin-answer-method">回答文の作成：{answerMethod(answer)}</p>
                      )}
                      {answer.incomplete && (
                        <p className="admin-chat-incomplete">返信の途中（未完了）</p>
                      )}
                      <AdminAnswerDetails answer={answer} />
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() =>
                          setDetail({ conversationId: answer.conversationId, answerId: answer.id })
                        }
                      >
                        会話と回答を確認
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  title="この条件の回答記録はありません"
                  detail="お客様への回答を受け付けると、ここに記録されます。"
                />
              )}
            </section>
          )}
          {usage && (
            <details className="admin-card ai-usage-totals">
              <summary>APIごとの使用量</summary>
              <p className="help">
                API記録開始：
                {usage.recordingStartedAt ? datetime(usage.recordingStartedAt) : '呼び出しなし'}
                。トークンは取得済み分の合計です。未取得はゼロとして扱いません。
              </p>
              <div className="admin-two-col">
                {usage.summaries
                  .filter((s) => (provider ? s.provider === provider : s.calls > 0))
                  .map((s) => (
                    <section className="admin-card" key={s.provider}>
                      <h3>{aiProviders[s.provider]}</h3>
                      <dl className="ai-usage-summary">
                        <div>
                          <dt>呼び出し</dt>
                          <dd>{s.calls.toLocaleString()}回</dd>
                        </div>
                        <div>
                          <dt>結果を採用</dt>
                          <dd>{s.accepted}回</dd>
                        </div>
                        <div>
                          <dt>検証で不採用</dt>
                          <dd>{s.rejected}回</dd>
                        </div>
                        <div>
                          <dt>エラー / 完了記録なし</dt>
                          <dd>
                            {s.failed} / {s.pending}回
                          </dd>
                        </div>
                        <div>
                          <dt>入力トークン</dt>
                          <dd>{s.inputTokens?.toLocaleString() ?? '未取得'}</dd>
                        </div>
                        <div>
                          <dt>出力トークン</dt>
                          <dd>{s.outputTokens?.toLocaleString() ?? '未取得'}</dd>
                        </div>
                        <div>
                          <dt>キャッシュ済み入力</dt>
                          <dd>{s.cachedInputTokens?.toLocaleString() ?? '未取得'}</dd>
                        </div>
                      </dl>
                      <p className="help">
                        使用量の取得：{s.usageReportedCalls} / {s.calls}
                        回。料金は提供元の請求画面で確認してください。
                      </p>
                    </section>
                  ))}
              </div>
              {!usage.total && <p>この条件のAPI呼び出しはありません。</p>}
            </details>
          )}
          {scope !== 'chat' && usage && (
            <section className="admin-card table-scroll ai-usage-details">
              <h2>{scope === 'connection_check' ? '接続確認の明細' : 'その他のAPI処理の明細'}</h2>
              <p className="help">
                {usage.total}件のうち、最新{usage.items.length}件を表示しています。
              </p>
              {usage.items.length ? (
                <table className="data-table ai-usage-table">
                  <thead>
                    <tr>
                      <th>時刻 / API</th>
                      <th>用途 / モデル</th>
                      <th>結果</th>
                      <th>時間 / トークン</th>
                      <th>通信詳細</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.items.map((call) => (
                      <tr key={call.id}>
                        <td>
                          {datetime(call.createdAt)}
                          <small>{aiProviders[call.provider]}</small>
                        </td>
                        <td>
                          {aiPurpose(call)}
                          <small>{call.model}</small>
                        </td>
                        <td>
                          {aiOutcomes[call.outcome]}
                          {call.errorCode && <small>{call.errorCode}</small>}
                        </td>
                        <td>
                          {call.durationMs === null
                            ? '未確定'
                            : `${(call.durationMs / 1000).toFixed(2)}秒`}
                          <small>
                            {call.usage
                              ? `入力 ${call.usage.inputTokens} / 出力 ${call.usage.outputTokens}`
                              : '使用量は未取得'}
                          </small>
                        </td>
                        <td>
                          <AiCallDetails call={call} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty title="この条件のAPI呼び出し記録はありません" />
              )}
            </section>
          )}
        </>
      )}
      {detail && (
        <ConversationDetail
          id={detail.conversationId}
          selectedAnswerId={detail.answerId}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  );
}
