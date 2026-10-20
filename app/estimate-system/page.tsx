import SiteShell from '@/components/SiteShell';
import Breadcrumbs from '@/components/Breadcrumbs';
import ConsultationLinks from '@/components/ConsultationLinks';
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata(
  '法人向けチャット見積システムの導入相談',
  'Webサイトで商品相談の条件を整理し、見積依頼を受け付け、担当者の確認後に見積書を発行する仕組み。北九州・福岡の企業様向け導入相談。',
  '/estimate-system',
);
export default function EstimateSystem() {
  return (
    <SiteShell>
      <Breadcrumbs
        items={[
          { name: 'ホーム', path: '/' },
          { name: 'チャット見積システムの導入相談', path: '/estimate-system' },
        ]}
      />
      <div className="page-hero">
        <div className="container">
          <p className="eyebrow">CHAT & QUOTATION</p>
          <h1>チャット相談を、見積依頼につなげる仕組み</h1>
          <p>
            北九州・福岡の企業様へ。Webサイトの相談受付と、担当者による見積作成をつなぐ導入相談。
          </p>
        </div>
      </div>
      <section className="section">
        <div className="container narrow prose">
          <h2>商品や仕様の聞き取りを、Webサイトから</h2>
          <p>
            お客様が商品名・型番・用途・必要数量をチャットで相談し、その条件を担当者へ引き継ぐ仕組みです。相談履歴と調査結果をもとに見積書のたたき台を作り、担当者が内容を確認してから正式発行します。
          </p>
          <ConsultationLinks subject="チャット見積システムの導入" />
          <h2>このサイトで開発している機能</h2>
          <ul>
            <li>商品名・用途・仕様の聞き取りと、登録商品・資料の参照</li>
            <li>候補の確認から、見積希望と連絡先の受付への案内</li>
            <li>会話履歴・調査結果を管理画面で確認</li>
            <li>見積書のたたき台作成、担当者による確認と正式発行</li>
            <li>専用リンクでの見積確認と注文依頼の受付</li>
          </ul>
          <h2>担当者の判断を組み込んだ見積の流れ</h2>
          <ol>
            <li>お客様が用途や仕様を相談します。</li>
            <li>商品候補と必要な条件を確認します。</li>
            <li>見積希望を確認し、連絡先を受け付けます。</li>
            <li>担当者が条件と明細を確認し、正式な見積書を発行します。</li>
          </ol>
          <p>
            未確認の価格・在庫・納期は確定情報として案内しません。外部へのメール通知・送付は別途連携が必要です。
          </p>
        </div>
      </section>
      <section className="section section-muted">
        <div className="container narrow prose">
          <h2>御社の業務に合わせて、導入範囲から相談</h2>
          <p>
            現在の商品資料の形式、受付から見積発行までの手順、確認する担当者、利用中のシステムをお聞かせください。必要な機能と連携範囲を整理します。
          </p>
          <p>
            導入費用、月額費用、提供時期、保守・サポート、他社システムとの連携可否は個別確認となります。このページは導入相談の窓口です。
          </p>
          <h2>よくあるご質問</h2>
          <div className="service-faq">
            <details>
              <summary>すべての見積を自動発行できますか？</summary>
              <p>
                このサイトの仕組みは担当者の確認を経て正式発行します。自動化する範囲は商品と業務条件に応じて検討します。
              </p>
            </details>
            <details>
              <summary>今あるExcelやPDFを使えますか？</summary>
              <p>
                登録機能はありますが、資料の形式・項目・公開範囲の確認が必要です。画像だけのPDFや独自システムとの接続は、追加対応の要否を確認します。
              </p>
            </details>
          </div>
          <ConsultationLinks subject="チャット見積システムの導入" />
        </div>
      </section>
    </SiteShell>
  );
}
