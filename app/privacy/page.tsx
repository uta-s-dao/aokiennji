import { pageMetadata } from '@/lib/seo';
import SiteShell from '@/components/SiteShell';
export const metadata = pageMetadata(
  'プライバシーに関するご案内',
  'お問い合わせ・見積依頼・チャットでお預かりする情報の利用目的と管理についてご案内します。',
  '/privacy',
);
export default function Privacy() {
  return (
    <SiteShell>
      <div className="page-hero">
        <div className="container">
          <p className="eyebrow">PRIVACY</p>
          <h1>プライバシーに関するご案内</h1>
        </div>
      </div>
      <section className="section">
        <div className="container narrow prose">
          <p>
            このサイトは、ご相談への対応とサービスの確認のため、お問い合わせ・見積依頼で入力されたお名前、会社名、メールアドレス、相談内容、チャットでの会話を保存します。
          </p>
          <h2>利用目的</h2>
          <p>
            お問い合わせへの回答、製品の確認、見積作成、注文依頼への対応、サービス改善のために利用します。
          </p>
          <h2>情報の管理</h2>
          <p>
            管理画面は認証された担当者のみが利用します。注文依頼は担当者による確認を経て処理されます。
          </p>
          <h2>利用状況の分析について</h2>
          <p>
            アクセス解析を有効にした場合は、Google
            アナリティクスを利用し、同意いただいた方の閲覧ページ、電話リンクの操作、チャットの開始、問い合わせ・見積依頼の受付を集計します。分析用のCookieを使用します。氏名、メールアドレス、相談本文、会話内容、見積書の専用リンクは分析イベントに含めません。管理画面・見積確認画面は計測対象外です。
          </p>
          <p>
            初期状態では分析を停止しています。有効な場合、ページ下部の「分析に同意する」から許可でき、同じ場所から取り消せます。分析を許可しなくてもご相談いただけます。解析データの管理担当・保存期間などは、公開前に会社確認を行います。
          </p>
          <h2>ご連絡先</h2>
          <p>保存内容の確認や訂正については、お問い合わせフォームからご連絡ください。</p>
          <div className="notice-box">
            このサイトは試験運用中です。正式なプライバシーポリシーは運用開始前に確認・公開する必要があります。
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
