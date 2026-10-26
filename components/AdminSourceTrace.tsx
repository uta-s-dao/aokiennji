import type { SourceTrace } from '@/lib/contracts';
import { datetime } from './api';

const scopeLabels = {
  registered_data: '登録商品・取込資料',
  preferred_sites: '優先参照サイト',
  past_sources: '過去の調達先',
  public_web: '外部Web',
};
const outcomeLabels = {
  candidate: '調達・照会候補（条件未確認）',
  identified: '商品・関連情報を確認',
  mismatch: '型番・仕様が不一致',
  unreachable: '取得できず未確認',
  discovered: '検索結果・ページ未照合',
};

export default function AdminSourceTrace({ trace }: { trace: SourceTrace }) {
  const domains = new Set(trace.preferredSites.filter((s) => s.eligible).map((s) => s.domain));
  const external = trace.stages.some((s) => s.scope === 'public_web');
  return (
    <details className="research-excerpt source-trace">
      <summary>
        この回答の情報源・検索経路（優先参照{domains.size}サイト／外部Web
        {external ? '拡張あり' : '拡張なし'}）
      </summary>
      <p>回答当時の記録です。購入・見積窓口の記載は、在庫確保・発注完了を意味しません。</p>
      {trace.reusedFromNoteId && (
        <p>直前の調査を再利用：{trace.reusedFromNoteId}（下記は元の取得日時）</p>
      )}
      {trace.conclusion && <p className="preline">{trace.conclusion}</p>}
      {trace.investigation && (
        <details>
          <summary>Jevによる調査判断（{trace.investigation.actions.length}回）</summary>
          <p>調査対象：{trace.investigation.subject}</p>
          <p>終了理由：{trace.investigation.stopReason || '調査中'}</p>
          <ol className="research-bullets">
            {trace.investigation.actions.map((action, i) => (
              <li key={i}>
                <strong>
                  {action.action.startsWith('url_')
                    ? 'ページ取得'
                    : action.action.startsWith('doc_')
                      ? '社内資料を読む'
                      : action.action === 'search' || action.action === 'public_search'
                        ? '追加検索'
                        : action.action.startsWith('candidate_')
                          ? '商品候補の選択（未確定）'
                          : action.action.startsWith('ask_')
                            ? '顧客への追加質問'
                            : '調査終了'}
                </strong>
                <p>{action.target || action.label}</p>
                {action.batchTargets?.map((url) => (
                  <p key={url}>同じ判断で取得：{url}</p>
                ))}
                <p>
                  結果：{action.outcome}・{datetime(action.at)}
                  {action.confidence !== undefined
                    ? `・判断の確信度：${Math.round(action.confidence * 100)}%`
                    : ''}
                </p>
              </li>
            ))}
          </ol>
          {trace.investigation.question && <p>追加質問：{trace.investigation.question}</p>}
        </details>
      )}
      <ol className="research-bullets">
        {trace.stages.map((stage, i) => (
          <li key={i}>
            <strong>
              {scopeLabels[stage.scope]}：
              {stage.status === 'done'
                ? '完了'
                : stage.status === 'failed'
                  ? '失敗・未確認'
                  : stage.status === 'skipped'
                    ? '省略'
                    : '実行中'}
            </strong>
            <p>{stage.reason}</p>
            <p>
              開始：{datetime(stage.startedAt)}・取得候補{stage.returnedUrls.length}件
            </p>
            <details>
              <summary>検索語・対象ドメイン・取得候補URL</summary>
              <p>{stage.query}</p>
              <p>{stage.domains.join('、') || 'ドメイン指定なし（登録資料の照合を含む）'}</p>
              {stage.returnedUrls.map((url) => (
                <p key={url}>{url}</p>
              ))}
              {stage.searches?.map((search, searchIndex) => (
                <details key={searchIndex}>
                  <summary>検索APIが返した検索語・参照URLと対象外の除外記録</summary>
                  <p>
                    {search.provider} {search.model || ''}
                  </p>
                  <p>検索APIの検索語：{search.queries.join('、') || 'APIから未提供'}</p>
                  <p>APIが返した参照・候補URL（本文確認済みとは限りません）：</p>
                  {search.consultedUrls.map((url) => (
                    <p key={url}>
                      {url}
                      {search.discardedUrls.includes(url) ? '（優先対象外のため不採用）' : ''}
                    </p>
                  ))}
                </details>
              ))}
            </details>
          </li>
        ))}
      </ol>
      {trace.observations.map((record, i) => (
        <section key={i} className="research-source">
          <strong>
            {scopeLabels[record.origin]}・{outcomeLabels[record.outcome]}
          </strong>
          <p>{record.title}</p>
          {/^(https?):\/\//i.test(record.url) ? (
            <a
              className="research-source-url"
              href={record.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {record.url}
            </a>
          ) : (
            record.url && <p>{record.url}</p>
          )}
          <p>{record.reason}</p>
          <p>
            取得・登録日時：{datetime(record.retrievedAt)}
            {record.sourceId ? `・情報源ID：${record.sourceId}` : ''}
          </p>
          <details>
            <summary>取得した根拠の抜粋</summary>
            <p className="preline">{record.excerpt || '本文を取得できていません。'}</p>
            {record.contentHash && <p>HTMLハッシュ：{record.contentHash}</p>}
          </details>
        </section>
      ))}
      <details>
        <summary>回答作成に渡した根拠と採用した段落</summary>
        {trace.answerCanonical && (
          <p className="preline">サーバーの確定案内：{trace.answerCanonical}</p>
        )}
        {trace.answerFacts?.map((fact) => (
          <p key={fact.id} className="preline">
            {fact.id}：{fact.text}
          </p>
        ))}
        {trace.answerBlocks?.map((block, i) => (
          <p key={i} className="preline">
            {block.text}
            <br />
            根拠ID：{block.evidenceIds.join('、') || '一般案内・確認事項'}
          </p>
        ))}
      </details>
      <details>
        <summary>回答当時の優先参照先一覧（保留を含む）</summary>
        {trace.preferredSites.map((site, i) => (
          <p key={i}>
            {site.name}・{site.url}・{site.eligible ? '優先対象' : '自動取得を保留'}：{site.reason}
          </p>
        ))}
      </details>
    </details>
  );
}
