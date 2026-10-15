import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || resolve(root, '.data/sites/company-questions/dist'));
const siteUrl = process.argv[3] || '';
if (siteUrl && new URL(siteUrl).protocol !== 'https:') throw Error('Site URL must use HTTPS');
const markdown = readFileSync(resolve(root, 'docs/COMPANY_QUESTIONS.md'), 'utf8');
const clean = markdown.replace(/```[\s\S]*?```/g, '');
const questions = [];
let current;
for (const line of clean.split('\n')) {
  const heading = line.match(/^### (Q\d+)\s+(.+)$/);
  if (heading) {
    current = {
      id: heading[1],
      title: heading[2],
      body: [],
      status: '未確認',
      answer: '',
      inAnswer: false,
    };
    questions.push(current);
  } else if (/^## /.test(line)) current = undefined;
  else if (current && /^回答欄：/.test(line)) {
    current.answer = line.replace(/^回答欄：/, '').trim();
    current.inAnswer = true;
  } else if (current && /^状態：/.test(line)) {
    current.status = line.replace(/^状態：/, '').trim();
    current.inAnswer = false;
  } else if (current && line.trim()) {
    if (current.inAnswer) current.answer += (current.answer ? '\n' : '') + line.trim();
    else current.body.push(line.trim());
  }
}
if (!questions.length || new Set(questions.map((q) => q.id)).size !== questions.length)
  throw Error('Question IDs must exist and be unique');
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const updated = markdown.match(/最終更新日：([^\n]+)/)?.[1].trim() || '';
const toc = questions
  .map(
    (q) =>
      '<a href="#' + q.id.toLowerCase() + '"><span>' + q.id + '</span>' + escape(q.title) + '</a>',
  )
  .join('\n');
const cards = questions
  .map(
    (q) =>
      '<article class="question" id="' +
      q.id.toLowerCase() +
      '"><div class="question-meta"><span class="question-id">' +
      q.id +
      '</span><span class="status">' +
      escape(q.status) +
      '</span></div><h2>' +
      escape(q.title) +
      '</h2>' +
      q.body.map((p) => '<p class="question-text">' + escape(p) + '</p>').join('') +
      '<div class="answer-space"><label class="answer-label" for="answer-' +
      q.id +
      '">' +
      q.id +
      ' の回答・メモ</label><textarea class="answer-input" id="answer-' +
      q.id +
      '" name="' +
      q.id +
      '" rows="4" maxlength="20000" aria-describedby="draft-help-text" placeholder="会社さんから聞いた回答や、確認したいことを入力してください">' +
      escape(q.answer) +
      '</textarea><div class="answer-print"></div><label class="confirm-label"><input class="answer-confirmed" type="checkbox"' +
      (q.answer && ['回答済み', '反映済み'].includes(q.status) ? ' checked' : '') +
      '>会社に確認済みの回答</label></div></article>',
  )
  .join('\n');
const pending = questions.filter((q) => q.status === '未確認').length;
const html = [
  '<!doctype html>',
  '<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>アオキエンジ様への確認事項</title><meta name="description" content="商品相談チャットの販売条件・配送・納期について、会社への確認事項をまとめた質問票です。"><meta name="robots" content="noindex,nofollow">',
  siteUrl ? '<link rel="canonical" href="' + escape(siteUrl) + '">' : '',
  '<style>',
  ':root{color-scheme:light;--ink:#142e46;--muted:#597083;--line:#dce5ec;--paper:#fff;--blue:#2363a0;--tint:#edf4fa}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:28px}body{margin:0;background:#f3f6f9;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP","Yu Gothic",Meiryo,sans-serif;font-size:16px;line-height:1.9}a{color:var(--blue)}button,a{touch-action:manipulation}a:focus-visible,button:focus-visible{outline:3px solid #5d9dd7;outline-offset:4px}.topbar{background:var(--ink);color:white;padding:20px max(24px,calc((100vw - 1180px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font-weight:700;letter-spacing:.12em;font-size:15px}.document-label{font-size:12px;opacity:.75}.wrap{max-width:1228px;padding:48px 24px 64px;margin:auto}.hero{border-bottom:1px solid var(--line);padding-bottom:32px;margin-bottom:32px}.eyebrow{font-size:12px;letter-spacing:.12em;color:var(--blue);font-weight:700;margin:0 0 10px}h1{font-size:clamp(28px,4vw,40px);line-height:1.5;margin:0 0 18px;letter-spacing:.02em}.intro{max-width:830px;color:var(--muted);margin:0}.meta{display:flex;gap:12px 24px;flex-wrap:wrap;margin-top:20px;color:var(--muted);font-size:13px}.tools{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}.button{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);background:var(--paper);border-radius:6px;padding:10px 18px;font:inherit;font-size:14px;text-decoration:none;cursor:pointer;color:var(--ink)}.button.primary{background:var(--ink);border-color:var(--ink);color:white}.layout{display:grid;grid-template-columns:252px minmax(0,1fr);gap:36px;align-items:start}.sidebar{position:sticky;top:24px}.sidebar h2{font-size:14px;margin:0 0 12px}.nav{display:grid;gap:2px}.nav a{display:flex;gap:12px;padding:10px 0;text-decoration:none;color:var(--muted);font-size:13px;line-height:1.65;border-bottom:1px solid var(--line)}.nav a:hover{color:var(--blue)}.nav span{font-size:11px;font-weight:700;color:var(--blue);padding-top:2px;white-space:nowrap}.side-note{font-size:12px;color:var(--muted);margin-top:20px}.question{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:28px 32px;margin-bottom:18px;scroll-margin-top:24px;overflow-wrap:anywhere}.question-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.question-id{font-size:12px;letter-spacing:.08em;font-weight:700;color:var(--blue)}.status{font-size:11px;border-radius:4px;padding:3px 10px;background:var(--tint);color:var(--blue)}.question h2{font-size:21px;line-height:1.55;margin:0 0 16px}.question p{margin:0;color:#334f66}.question p+p{margin-top:12px}.answer-space{margin-top:24px;border-top:1px dashed var(--line);padding-top:12px;color:#81909c;font-size:12px}.ending{margin-top:26px;padding:24px 28px;background:#eaf0f5;border-radius:8px;color:var(--muted);font-size:14px}.ending h2{font-size:16px;color:var(--ink);margin:0 0 8px}.ending p{margin:0}.footer{margin-top:36px;padding-top:20px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.skip{position:absolute;left:16px;top:-80px;background:white;padding:10px 16px;z-index:2}.skip:focus{top:16px}@media(max-width:760px){.topbar{padding:16px 20px}.document-label{display:none}.wrap{padding:28px 18px 40px}.layout{grid-template-columns:1fr;gap:24px}.sidebar{position:static}.nav{grid-template-columns:1fr 1fr;gap:0 18px}.side-note{display:none}.question{padding:22px 20px}.question h2{font-size:19px}.hero{padding-bottom:24px;margin-bottom:24px}.ending{padding:20px}.meta{gap:6px 18px}.button{flex:1;font-size:13px;white-space:nowrap}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{body{background:white;font-size:11pt}.topbar{background:white;color:var(--ink);padding:0 0 12px;border-bottom:1px solid var(--line)}.wrap{max-width:none;padding:20px 0}.tools,.sidebar,.skip{display:none}.layout{display:block}.question{break-inside:avoid;padding:18px 20px;border-radius:0}.answer-space{min-height:48px}.hero{margin-bottom:20px;padding-bottom:20px}h1{font-size:25pt}.question h2{font-size:15pt}.footer{margin-top:20px}}',
  '</style><link rel="stylesheet" href="answers.css"></head><body><a class="skip" href="#questions">質問へ移動</a>',
  '<header class="topbar"><span class="brand">AOKI ENG</span><span class="document-label">会社への確認事項 / 質問票</span></header>',
  '<main class="wrap"><section class="hero" aria-labelledby="title"><p class="eyebrow">商品相談チャットの運用に向けて</p><h1 id="title">アオキエンジ様への<br>確認事項</h1><p class="intro">各質問に直接、回答・メモを書き込めます。確認事項は今後も随時追記し、最後にまとめてご相談します。</p>',
  '<div class="meta"><span>質問 ' +
    questions.length +
    '件</span><span id="answer-progress">入力済み 0件</span><span>最終更新：' +
    escape(updated) +
    '</span></div>',
  '<div class="tools"><button type="button" class="button primary" data-action="download-memo">回答メモをダウンロード</button><button type="button" class="button" data-action="copy-memo">回答メモをコピー</button><button type="button" class="button" id="print">印刷・PDF保存</button></div><div class="draft-help"><p id="draft-help-text">入力内容はこの端末のブラウザーに自動保存します。他の端末とは共有されません。回答メモをダウンロードまたはコピーして、作成を依頼したチャットに渡してください。</p><p id="draft-status" role="status" aria-live="polite">各質問の回答・メモ欄に入力できます。</p></div><noscript><p>入力内容の保存・書き出しにはJavaScriptを有効にしてください。</p></noscript></section>',
  '<div class="layout"><aside class="sidebar"><h2>確認する項目</h2><nav class="nav" aria-label="質問の目次">' +
    toc +
    '</nav><p class="side-note">質問番号を維持して追記します。<br>回答が確認できた項目から、運用や設定へ反映します。</p></aside>',
  '<div id="questions">' +
    cards +
    '<section class="memo-panel"><h2>その他のメモ・チャットへの受け渡し</h2><label class="answer-label" for="general-note">その他のメモ（追加の質問など）</label><textarea class="answer-input" id="general-note" rows="4" maxlength="20000" placeholder="質問番号に当てはまらない内容も、ここに書けます"></textarea><div class="answer-print" id="general-print"></div><ol class="transfer-steps"><li>各質問の回答・メモを入力する</li><li>「回答メモをダウンロード」または「回答メモをコピー」を押す</li><li>作成を依頼したチャットに、ファイルを添付するかメモを貼り付ける</li></ol><div class="tools"><button type="button" class="button primary" data-action="download-memo">回答メモをダウンロード</button><button type="button" class="button" data-action="copy-memo">回答メモをコピー</button></div><p id="transfer-status" role="status" aria-live="polite"></p><details id="memo-preview"><summary>チャットに渡す回答メモを表示</summary><label class="answer-label" for="memo-text">チャットに貼り付ける回答メモ（コピー用）</label><textarea class="memo-text" id="memo-text" readonly rows="10"></textarea></details><p class="source-download"><a href="company-questions.md" download>原本の質問票をダウンロード</a></p></section>' +
    '<section class="ending"><h2>今後の確認事項も、ここへ追記します</h2><p>未決定の内容や開発用の仮の数値を、会社の方針として扱うことはありません。確認待ちの条件に依存しない開発・検証は進めます。</p></section></div></div>',
  '<footer class="footer">アオキエンジ様への確認事項 · 質問票・回答メモ</footer></main><script src="answers.js" defer></script></body></html>',
].join('\n');
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'index.html'), html);
writeFileSync(resolve(output, 'company-questions.md'), markdown);
for (const filename of ['answers.js', 'answers.css']) {
  writeFileSync(
    resolve(output, filename),
    readFileSync(resolve(root, 'scripts/company-questions', filename)),
  );
}
console.log(JSON.stringify({ output, questions: questions.length, pending, updated }));
