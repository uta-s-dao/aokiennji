import { IDENTIFICATION_QUESTION, PHOTO_GUIDE, photoHelpRequested } from '../consultation-policy';
import { company, projects, services } from '../company';
import type { CompanyFaq } from '../contracts';
import { policyKeys, requestPatterns, stripCourtesy, type PolicyKey } from '../chat-policy';

// Selection checklists in general engineering terms. They hold no prices,
// stock or supplier facts, so both the response model and the local fallback
// may use them to move a consultation forward.
const temperature = /\d+\s*(?:度|℃|°C)|温度|常温|高温|低温|加熱|熱く|熱い/;
const fluid = /水|油|蒸気|空気|エア|ガス|薬液|薬品|洗浄液|流体/;
const pressure = /圧力|MPa|kPa|気圧|高圧|低圧/;
const size =
  /\d+\s*(?:mm|ミリ|みり|cm|センチ|せんち|A(?![A-Za-z])|インチ)|寸法|サイズ|大きさ|おおきさ|内径|外径|直径|長さ|幅|厚さ|角/;
const material =
  /材質|ステンレス|SUS|鉄|鋼|アルミ|銅|真鍮|ゴム|樹脂|フッ素|シリコン|PTFE|セラミック|ガラス/;
const quantity = /\d+\s*(?:個|台|本|枚|セット|m(?![A-Za-z])|メートル)|数量/;
const timing = /納期|までに|来週|今週|今月|来月|急ぎ|いつまで/;
const purpose = /用途|使う|使い|使用|交換|補修|設備|ため/;
type Point = [label: string, mentioned: RegExp];
const checklists: Record<string, Point[]> = {
  バルブ: [
    ['流体', fluid],
    ['温度', temperature],
    ['圧力', pressure],
    ['配管サイズ（口径）', /\d+\s*(?:A(?![A-Za-z])|mm|ミリ|インチ)|口径|呼び径/],
    ['接続方式（ねじ込み・フランジ等）', /ねじ込み|フランジ|溶接|差し?込|接続/],
    ['操作方法（手動・自動）', /手動|手で|電動|自動|空気式|ハンドル|レバー/],
  ],
  パッキン: [
    [
      '寸法（内径・外径・厚さ）',
      /内径|外径|厚さ|寸法|\d+\s*(?:mm|ミリ)|\d+\s*A(?![A-Za-z])|呼び径|\d+\s*K\b/,
    ],
    ['材質', material],
    // Steam at a stated pressure fixes the temperature.
    ['使用温度', new RegExp(`${temperature.source}|蒸気`)],
    ['流体', fluid],
    ['圧力', pressure],
    ['使う機器・箇所', /ポンプ|フランジ|配管|機器|装置|箇所|部分|ふた|蓋/],
  ],
  ガラス: [
    ['使用温度', temperature],
    ['寸法と厚さ', /\d+\s*(?:mm|ミリ|みり|cm|センチ|せんち)|角|厚さ|寸法|サイズ|大きさ|おおきさ/],
    ['温度変化（加熱・冷却の頻度）', /加熱|冷ま|冷却|急冷|急熱|温度変化|熱衝撃|毎日|頻度/],
    ['取付方法', /取付|取り付け|枠|はめ込|固定/],
    ['用途（覗き窓・カバー等）', /覗|のぞ|窓|カバー|照明|用途/],
  ],
  断熱材: [
    ['使用温度', temperature],
    ['厚さと形状（板・シート等）', /厚さ|\d+\s*(?:mm|ミリ)|板|シート|ボード|ブランケット|形状/],
    ['施工する場所（平面・配管等）', /外側|内側|配管|装置|炉|平ら|曲が|屋外|屋内|設置/],
    ['表面の仕上げ・粉じん対策', /粉|表面|カバー|覆|仕上|触/],
    ['施工する面積・数量', /面積|平米|㎡|\d+\s*(?:枚|m(?![A-Za-z])|メートル)|数量/],
  ],
  金網: [
    ['材質', material],
    ['目開き（網目の大きさ）', /網目|目開き|メッシュ|目の大きさ/],
    ['線径（線の太さ）', /線径|線の太さ|太さ/],
    ['寸法', /幅|奥行|\d+\s*(?:mm|ミリ)|寸法/],
    ['使用環境（水・薬品・温度）', /水|洗浄|薬|温度|屋外|環境/],
  ],
  ホース: [
    ['流す流体', fluid],
    ['温度', temperature],
    ['圧力', pressure],
    ['内径と長さ', /内径|長さ|\d+\s*(?:mm|ミリ|m(?![A-Za-z])|メートル)|サイズ/],
    ['接続金具', /金具|継手|カプラ|接続|口金/],
  ],
  ポンプ: [
    ['流体', fluid],
    ['必要な流量', /流量|L\/min|リットル|毎分|吐出/],
    ['揚程・圧力', /揚程|圧力|MPa|高さ/],
    ['温度', temperature],
    ['電源（電圧・単相/三相）', /電源|\d+\s*V(?![A-Za-z])|三相|単相|電圧/],
    ['配管口径・設置条件', /口径|\d+\s*A(?![A-Za-z])|設置|据え?付|配管/],
  ],
  スタッド: [
    ['ねじの呼び（M8等）', /M\d+|ねじの|呼び/],
    ['全長とねじ部の長さ', /長さ|全長|\d+\s*(?:mm|ミリ)/],
    ['材質', material],
    ['使用環境（屋内・高温等）', /屋内|屋外|温度|炉|環境|設備/],
    ['形状・規格', /規格|JIS|両ねじ|植込み|形状|ねじのない|ねじ無/],
  ],
  台車: [
    ['積載重量', /\d+\s*(?:kg|キロ|トン)|重さ|重量|積載/],
    ['床と段差', /床|段差|スロープ|路面/],
    ['車輪の材質', /車輪|キャスター|ゴム|樹脂|ウレタン/],
    ['寸法（荷台・通路幅）', /幅|寸法|通路|\d+\s*(?:mm|ミリ)/],
    ['使用環境', /工場|屋外|屋内|粉|油|水|温度/],
  ],
  炉: [
    ['使用温度', temperature],
    ['材質', material],
    ['寸法', size],
    ['取付方法', /取付|取り付け|固定|溶接|ボルト/],
    ['炉内の雰囲気（ガス・腐食）', /酸化|還元|ガス|雰囲気|腐食/],
  ],
  工具: [
    ['加工する材料', /ステンレス|SUS|鉄|鋼|アルミ|銅|樹脂|材料|材質|板/],
    ['加工の内容（穴あけ・切断等）', /穴|切断|切る|削|研削|曲げ|加工/],
    ['寸法（板厚・穴径）', /\d+\s*(?:mm|ミリ)|板厚|穴径|寸法/],
    ['使う機械（ボール盤・手持ち等）', /ボール盤|ドリル|旋盤|手持ち|電動|機械/],
    ['数量', quantity],
  ],
  継手: [
    ['流体', fluid],
    ['温度', temperature],
    ['圧力', pressure],
    ['配管サイズ', /\d+\s*(?:A(?![A-Za-z])|mm|ミリ|インチ)|口径|サイズ/],
    ['接続方式（ねじ込み・フランジ等）', /ねじ込み|フランジ|溶接|差し?込|接続/],
  ],
  材料: [
    ['材質（鋼種）', material],
    ['寸法（板厚・幅・長さ）', size],
    ['数量', quantity],
    ['加工の有無（切断・穴あけ等）', /切断|穴|曲げ|加工|溶接/],
    ['用途', purpose],
  ],
  ベルト: [
    ['形・サイズ（B形・B60等）', /[A-Z]-?\d{2,}|[A-Z]形|サイズ|長さ|呼び/],
    ['メーカー', /三ツ星|バンドー|ゲイツ|ニッタ|メーカー|純正/],
    ['本数', /\d+\s*本|本数|数量/],
    ['使う機械', /コンベア|ポンプ|ファン|モーター|機械|設備|用途/],
    ['ご希望の時期', timing],
  ],
  ベアリング: [
    ['呼び番号（6205等）', /\d{3,5}[A-Z]*|呼び番号|型番/],
    ['シール・シールド（ZZ・DDU等）', /ZZ|DDU|DU|2RS|シール|シールド|開放/i],
    ['すきま（C3等）', /C[2-5]|CM\b|すきま|隙間|CN/],
    ['メーカー指定の有無', /NSK|NTN|ジェイテクト|JTEKT|光洋|不二越|ミネベア|純正|メーカー|指定/],
    ['数量', quantity],
  ],
  ボルト: [
    ['ねじの呼び（M16等）', /M\d+|ねじの|呼び/],
    ['長さ', /[x×]\s*\d+|長さ|\d+\s*(?:mm|ミリ)/],
    ['材質・強度区分', /SUS|ステンレス|鉄|強度|\d+\.\d|材質|メッキ|ユニクロ|ドブ/],
    ['ナット・座金の有無', /ナット|座金|ワッシャー|セット/],
    ['数量', quantity],
  ],
  製作: [
    ['図面・寸法', /図面|寸法|\d+\s*(?:mm|ミリ)|CAD|PDF|現物/],
    ['材質', material],
    ['数量', quantity],
    ['用途・使用環境', /用途|使う|環境|温度|屋外|屋内/],
    ['希望の時期', timing],
  ],
};
const general: Point[] = [
  ['用途（何に使うか）', purpose],
  ['使用環境（温度・流体など）', /温度|水|油|屋外|屋内|環境|薬|熱/],
  ['大きさ・寸法', size],
  ['材質', material],
  ['数量', quantity],
  ['希望の時期', timing],
];
const aliases: [RegExp, string][] = [
  [/バルブ|弁|ばるぶ/, 'バルブ'],
  [/パッキン|ぱっきん|ガスケット|ジョイントシート|Oリング/, 'パッキン'],
  [/ベアリング|軸受|\b\d{4,5}(?:ZZ|DDU|DU|2RS|VV|LLU)/i, 'ベアリング'],
  [/[VＶ]ベルト|タイミングベルト|平ベルト|ベルト/, 'ベルト'],
  [/ガラス|覗き窓|のぞき窓|窓|まど/, 'ガラス'],
  [/断熱|保温|耐熱材|ブランケット|セラミックファイバー/, '断熱材'],
  [/金網|メッシュ|織金物/, '金網'],
  [/ホース/, 'ホース'],
  [/スタッド|植込みボルト|頭のない棒/, 'スタッド'],
  [/ボルト|ナット|ビス|座金|ワッシャー/, 'ボルト'],
  [/ポンプ|ぽんぷ/, 'ポンプ'],
  [/台車|キャスター|車輪/, '台車'],
  [/炉内金物|耐熱金物|耐火|炉の部品|炉内|炉の中|炉で/, '炉'],
  [/工具|ドリル|刃物|研削/, '工具'],
  [/継手|継ぎ手|ジョイント(?!シート)|配管資材/, '継手'],
  [
    /鋼板|鋼材|ステンレス板|プレート|チタン|非鉄|鏡板|板材|丸棒|角棒|フラットバー|アングル|(?:SUS|SS|SPCC|SPHC|A\d{4})\d*[^。、]{0,8}(?:板|材|パイプ|管|棒)/,
    '材料',
  ],
  [/製作|設計|特注|図面から|ブラケット|架台|ダクト|鋳物/, '製作'],
  // A description without the item's name ("水の流れを止める部品"), used only
  // when no item is named.
  [/流れを止め|開け閉め|開閉/, 'バルブ'],
];
// "ポンプのモーター用", "用途はポンプ": where the item is used, not the item.
const usageBefore = /(?:用途は|用途が|用途:)[^。、]{0,10}$/;
const usageAfter =
  /^(?:用|向け|側|周り|まわり|に使|で使|の(?:モーター|モータ|軸|定修|修理|メンテ|点検|ライン|設備|装置|中|内部|配管|部分|振動|側))/;
export function itemMention(text: string, pattern: RegExp) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    const before = text.slice(Math.max(0, match.index - 14), match.index);
    const after = text.slice(match.index + match[0].length);
    if (!usageBefore.test(before) && !usageAfter.test(after)) return true;
  }
  return false;
}
// The newest explicit mention wins, so a topic change is followed. A word
// naming only where the item is used ("ポンプのモーター用") is skipped.
export function consultationTopic(texts: string[]): string | undefined {
  for (const text of texts) {
    const normalized = text.normalize('NFKC');
    const found = aliases.find(([pattern]) => itemMention(normalized, pattern));
    if (found) return found[1];
  }
}
// How a topic is named to the customer.
const topicNames: Record<string, string> = {
  炉: '炉内の部品',
  製作: '製作品',
  材料: '鋼材・板材',
  スタッド: 'スタッドボルト',
  継手: '継手',
  ボルト: 'ボルト・ナット',
};
export function topicName(topic?: string) {
  return topic ? topicNames[topic] || topic : undefined;
}
export function checklist(topic?: string): string[] {
  return (topic ? checklists[topic] : general).map(([label]) => label);
}
const unknownWords =
  /分から|分かりません|分かってい(?:ない|ません)|わから|わかりません|不明|未定|未確認|確認中|調べてい(?:ない|ません)|測れ(?:てい)?(?:ない|ません)|読め(?:ない|ません)|決まってい(?:ない|ません)/;
// known: stated. unknown: the customer said it is not known yet. missing: not
// mentioned, so it may be asked once.
function pointStatus(topic: string | undefined, texts: string[]) {
  const sentences = texts.flatMap((t) => t.normalize('NFKC').split(/(?<=[。！!？?\n])/));
  return (topic ? checklists[topic] : general).map(([label, pattern]) => {
    const states = sentences.flatMap((sentence) => {
      const match = pattern.exec(sentence);
      if (!match) return [];
      const after = sentence.slice(match.index, match.index + match[0].length + 12);
      return [unknownWords.test(after) ? 'unknown' : 'known'];
    });
    const state = !states.length ? 'missing' : states.includes('known') ? 'known' : 'unknown';
    return { label, state };
  });
}

const conditionToken =
  /M\d+(?:\s*[x×]\s*\d+)?|[φΦ]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:ミリ角|mm角|A(?![A-Za-z])|mm|ミリ|みり|cm|センチ|せんち|メートル|m(?![A-Za-z])|度|℃|°C|kg|キロ|トン|MPa|kPa|リットル|L(?![A-Za-z])|インチ|kW|V(?![A-Za-z])|個|台|本|枚|セット|巻)/g;
const conditionWords = [
  '冷却水',
  '温水',
  '海水',
  '洗浄液',
  '水',
  '油',
  '蒸気',
  '手動',
  '電動',
  '屋内',
  '屋外',
  'ねじ込み',
  'フランジ',
  'ステンレス',
  '全開',
  '全閉',
];
const countUnit = /^\d+(個|台|本|枚|セット|巻)$/;
// "1枚あたり", "1本いくら": a unit price, not an amount.
const perUnit = /^\s*(?:あたり|当たり|につき|いくら|おいくら|の(?:価格|単価|値段))/;
// A choice asked about ("316Lにした方が無難でしょうか？") is not a condition.
const alternatives = /(?:方が|べき|それとも|どちら|どっち)[^。]*[？?]\s*$/;
// Repeat only what the customer wrote, never an inferred value. The newest
// mention comes first, and only the newest amount per unit is kept, so a
// change ("30枚→50枚") replaces the earlier amount.
export function statedConditions(texts: string[], limit = 6): string[] {
  const found: string[] = [];
  const counted = new Set<string>();
  const add = (value: string) => {
    // NFKC writes "℃" as "°C"; it is shown as the customer wrote it.
    const item = value.replace(/\s+/g, '').replace(/°C/g, '℃');
    const unit = item.match(countUnit)?.[1];
    if (unit) {
      if (counted.has(unit)) return;
      counted.add(unit);
    }
    if (!found.some((f) => f.includes(item) || item.includes(f))) found.push(item);
  };
  for (const text of texts.toReversed())
    for (const sentence of text
      .normalize('NFKC')
      .split(/(?<=[。！!？?\n])/)
      .toReversed()) {
      if (alternatives.test(sentence)) continue;
      const tokens = [...sentence.matchAll(conditionToken)]
        .filter((m) => !perUnit.test(sentence.slice(m.index + m[0].length)))
        .map((m) => m[0]);
      for (const token of tokens.toReversed()) add(token);
      for (const word of conditionWords) if (sentence.includes(word)) add(word);
    }
  return found.slice(0, limit);
}

// Complaints and fillers carry nothing for the staff ("同じ返事が続いていますね",
// "まあいいや").
const noise =
  /同じ返事|同じ答え|同じ文|空っぽ|答えになって|さっきも|何度も|言いましたよね|まあいいや|もう一回|もういい|困ります|聞いてるんです/;
const substance = /\d|[\p{Script=Katakana}ー]{3,}|[A-Za-z]{2,}/u;
// The customer's own sentences, without questions or requests addressed to us.
// The first ones (usually the item) and the latest ones are kept.
export function customerStatements(texts: string[], limit = 12): string[] {
  const lines: string[] = [];
  for (const text of texts)
    for (const sentence of text.normalize('NFKC').split(/(?<=[。！!？?\n])/)) {
      const line = stripCourtesy(sentence)
        .replace(/[。!！\s]+$/, '')
        .trim();
      if (line.length < 4 || /[？?]\s*$/.test(sentence)) continue;
      if (/(?:ですか|ますか|でしょうか|ませんか|ですよね|か)$/.test(line)) continue;
      // Requests about this reply ("短くまとめて", "書いてください") are not
      // conditions, but "50個で福岡への送料込みを希望、とまとめて" carries some.
      let kept = line;
      if (
        requestPatterns.summary.test(line) ||
        /(?:書|作|教え)(?:い|っ)?て(?:ください|ほしい)$/.test(line)
      ) {
        kept = line
          .replace(
            /[、,]?\s*(?:と|って)?\s*(?:問い?合わせ|フォーム|担当者)?[^、。]*?(?:まとめ|整理|要約|短く|文章|書|作|教え)[^。]*$/,
            '',
          )
          .replace(/^(?:では|じゃあ|それでは)[、,\s]*/, '');
        if (kept.length < 6 || !/\d|[都道府県市]/.test(kept)) continue;
      }
      if (/^(?:お願いします|お願いいたします)$/.test(kept)) continue;
      if (!substance.test(kept) && (noise.test(kept) || kept.length < 10)) continue;
      if (noise.test(kept) && !statedConditions([kept]).length) continue;
      const shown = kept.replace(/°C/g, '℃');
      const short = shown.length > 90 ? `${shown.slice(0, 89)}…` : shown;
      if (!lines.includes(short)) lines.push(short);
    }
  return lines.length <= limit ? lines : [...lines.slice(0, 2), ...lines.slice(2 - limit)];
}
// Model numbers, conditions and the destination named anywhere in the
// conversation, including in questions ("6206DDUCMを10個、金曜までに届く？").
const modelToken =
  /[A-Za-z][A-Za-z0-9]*(?:[-_－][A-Za-z0-9]+)+|[A-Za-z]{2,}\d+[A-Za-z0-9]*|\b[A-Za-z]\d{2,4}(?![A-Za-z0-9.])|\b\d{3,5}(?:ZZ|DDU|DU|VV|LLU|LLB|LLH|2RS|RS|NR|NSE|Z|N)(?:C[2-5]|CM)?\b/gi;
const notModel =
  /^(?:SUS|SS|SCS|SCH|SUH|SPCC|SPHC|SPCD|SECC|SGP|STPG|STK|STKR|SCM|SKD|SKH|SM|SWCH|JIS|NBR|EPDM|FKM|PTFE|PVC|ABS)[-\d]*[A-Z]?L?$|^(?:[MWDHLTtR]\d+|[AC]\d{4})$/i;
export function keyFacts(texts: string[], destination?: string): string[] {
  const models = [
    ...new Set(
      texts
        .flatMap((t) => t.normalize('NFKC').match(modelToken) || [])
        .filter((m) => /\d/.test(m) && !notModel.test(m)),
    ),
  ];
  const kept = models.filter((m) => !models.some((o) => o !== m && o.startsWith(m)));
  return [
    ...kept.slice(-4),
    ...statedConditions(texts, 8),
    ...(destination ? [`お届け先：${destination}`] : []),
  ];
}

// Fixed answers to questions about terms and the company. Nothing here is
// promised; the staff confirms each case. The company's own answers (FAQ in
// the settings) are used as written when given.
const passedOn = 'ご希望は、見積依頼の際にこの会話と一緒に当社へ届きます。';
const policyTexts: Record<PolicyKey, string> = {
  promise:
    '納期・在庫・価格のお約束は、このチャットではできません。確認したうえで、確かな内容をご案内します。',
  confirmed:
    'ご依頼や図面をお送りいただいた時点では、製作やご注文は確定しません。内容を確認してお見積りし、ご了承いただいてから手配します。',
  sourcing:
    'お取り寄せの可否は、メーカー名・品名・型番をもとに当社で確認します。登録されていない品目もご相談いただけます。',
  urgent:
    'お急ぎの場合は、お電話でのご相談が確実です。当日の対応や最短の手配は、在庫と配送を確認してご案内します。',
  payment: `お支払い方法・条件は、お取引条件として確認してご案内します。${passedOn}`,
  discount:
    '値引きをこの場でお約束することはできませんが、数量やご購入の頻度に応じた条件は、お見積りの際に確認します。',
  shipping: '送料はお届け先・数量・荷姿によって変わるため、お見積りでご案内します。',
  estimate: '登録価格のない品目は、目安の金額も、仕様と数量を確認してお見積りします。',
  quoteTime:
    'お見積りの回答時期は、品目と確認する内容によって異なるため、このチャットではお約束できません。回答の期限がある場合は、その日付もこの会話に書いておくと、依頼と一緒に当社へ届きます。',
  cutoff:
    '当日の出荷に間に合う受付の時刻は、品目と在庫によって異なるため、確認してご案内します。お急ぎの場合はお電話が確実です。',
  formEdit:
    'はい。フォームの「ご相談内容」には要点が入っていますが、送信前に自由に書き直せます。この会話の記録も依頼に添えられます。',
  quoteItems:
    'お見積りには、品名・型番（または仕様）、数量、お届け先、ご希望の納期があると確実です。この会話で伺った内容は見積依頼に引き継がれるため、書き直す必要はありません。',
  quoteContent:
    'はい。チャット下のボタンから送ると、この会話の記録が依頼に添えられ、当社で内容を確認します。入力欄にもここまでの要点が入ります。',
  pickup: `ご来社での引き取りは、在庫と準備の状況を確認してご案内します。${passedOn}`,
  outsourcing:
    '加工を社内で行うか協力会社と行うかは、内容に応じて当社で判断します。協力会社の社名や取引条件は公開していませんが、ご依頼の窓口は当社です。',
  location: `${company.name}は、〒${company.postalCode} ${company.address}にあります。`,
  contact: `${company.name}の電話番号は${company.phone}、FAXは${company.fax}です。`,
  hours:
    '営業時間は、このチャットに登録された情報がないためお答えできません。お電話でご確認ください。',
  visit: '現地調査や打ち合わせのご相談も承ります。伺える日程や範囲は、確認してご連絡します。',
  installation:
    '機械設備の据付や耐火材の施工も事業として承っています。現場の条件を確認したうえで、ご案内します。',
  sample: 'サンプルのご用意は品目によって異なるため、確認してご案内します。',
  catalog: 'カタログや資料の送付は、確認してご案内します。お探しの品目を添えてご依頼ください。',
  invoice: '請求書などの書類のご要望は、確認してご案内します。',
};
const NO_FAQ: CompanyFaq = { hours: '', quoteResponse: '', shipping: '', pickup: '' };
function policyText(key: PolicyKey, text: string, phone: boolean, faq: CompanyFaq) {
  const call = phone ? `お電話（${company.phone}）` : 'お電話';
  switch (key) {
    case 'urgent':
      return policyTexts.urgent.replace('お電話', call);
    case 'hours':
      return faq.hours
        ? `営業時間は、${faq.hours}です。`
        : policyTexts.hours.replace('お電話', call);
    case 'quoteTime': {
      // A deadline the customer already wrote is not asked for again.
      const dated =
        /\d+\s*(?:月\s*\d+\s*日|日まで|\/\s*\d+)|今週|来週|今月|来月|[月火水木金土日]曜/.test(text);
      const answer = faq.quoteResponse
        ? `お見積りの回答は、${faq.quoteResponse}が目安です（品目や確認する内容によって前後します）。`
        : policyTexts.quoteTime.replace(/回答の期限がある場合は.*$/, '');
      return `${answer}${
        dated
          ? '伺った期限も、依頼と一緒に当社へ届きます。'
          : faq.quoteResponse
            ? ''
            : '回答の期限がある場合は、その日付もこの会話に書いておくと、依頼と一緒に当社へ届きます。'
      }`;
    }
    case 'cutoff':
      return policyTexts.cutoff.replace('お電話', call);
    case 'shipping':
      return `${faq.shipping ? `送料について：${faq.shipping}。正確な送料は、お届け先と数量をもとにお見積りでご案内します。` : policyTexts.shipping}${
        /無料/.test(text) && !faq.shipping
          ? '送料無料になるかどうかも、お見積りの際に当社で確認します。'
          : ''
      }`;
    case 'pickup':
      return faq.pickup ? `引き取りについて：${faq.pickup}` : policyTexts.pickup;
    default:
      return policyTexts[key];
  }
}
export function policyAnswers(
  message: string,
  skip: PolicyKey[] = [],
  phone = true,
  faq: CompanyFaq = NO_FAQ,
) {
  const text = message.normalize('NFKC');
  return policyKeys(message)
    .filter((key) => !skip.includes(key))
    .map((key) => policyText(key, text, phone, faq))
    .join('\n');
}
// The company's own answers, for the response model.
export function faqFact(faq: CompanyFaq) {
  return [
    faq.hours && `営業時間: ${faq.hours}`,
    faq.quoteResponse && `見積回答の目安: ${faq.quoteResponse}`,
    faq.shipping && `送料について: ${faq.shipping}`,
    faq.pickup && `引き取りについて: ${faq.pickup}`,
  ]
    .filter(Boolean)
    .join(' / ');
}

export const HANDOFF_LABEL = 'この内容で相談を依頼する';
export const QUOTE_LABEL = 'この内容で見積を依頼する';
// How to reach the staff with the button shown under the reply. The phone
// number is given once per conversation.
export function handoffGuide(enabled: boolean, label = HANDOFF_LABEL, phone = true) {
  if (!enabled) return `ご相談は、お電話（${company.phone}）で承ります。`;
  return `下の「${label}」から、この会話の内容を添えて${
    label === QUOTE_LABEL ? 'お見積りを依頼できます' : '相談を依頼できます'
  }。${phone ? `お急ぎの場合はお電話（${company.phone}）でもご相談いただけます。` : ''}`;
}

export interface ComposeInput {
  // The customer's messages about the current topic, the current one last.
  customerTexts: string[];
  // A fixed first line, such as whether a registered product is handled.
  lead?: string;
  // Every customer message in the conversation, for a summary.
  allCustomerTexts?: string[];
  topic?: string;
  label?: string;
  // Earlier replies in this conversation, newest last.
  previousReplies?: string[];
  handoff: boolean;
  // The button shown under this reply, and whether the phone number may be
  // given (it is given once per conversation).
  guideLabel?: string;
  phone?: boolean;
  // The fixed part of this reply already explains how to reach the staff.
  guided?: boolean;
  // Where the customer wants the goods delivered, for a summary.
  destination?: string;
}
const askedPoint = /まだ伺っていない「(.+?)」/;
// "わかりません" answers the question asked just before.
const bareUnknown =
  /^(?:まだ)?(?:分から|わから|分かりません|わかりません|不明|未定|決まってい|知らない|読めない)/;
// Used when the response model is disabled or its draft is rejected: answer
// with what is known instead of asking for a product name again.
export function composeConsultation(input: ComposeInput, part: 'full' | 'next' = 'full') {
  const replies = input.previousReplies || [];
  const current = input.customerTexts.at(-1) || '';
  const said = input.customerTexts.join('\n');
  const previous = replies.at(-1) || '';
  const lines: string[] = [];
  if (input.lead && part === 'full') lines.push(input.lead);
  if (!replies.length && statedConditions(input.customerTexts).length) lines.push(`伺った条件：${statedConditions(input.customerTexts).join('・')}。`);
  if (/見積.*(?:不要|まだ|いらな|要らな)|見積は.*必要.*ない/.test(current))
    lines.push('見積依頼は進めません。取扱可否・在庫の確認として承ります。');
  if (/急ぎません|急いでいません|急ぎでは(?:ない|ありません)/.test(current))
    lines.push('お急ぎでないことを承知しました。');
  if (/在庫/.test(current)) lines.push('個別商品の在庫は商品を特定して登録情報と照合できます。登録在庫・仕入先の掲載在庫・確保済み数量は別で、ここではまだ在庫を確認できていません。');
  else if (/買え|購入|扱[いえっ]|取扱|販売/.test(current))
    lines.push('工業用品のご相談を承っていますが、その商品の販売・調達可否はまだ確認できていません。商品を特定して登録情報と照合できます。');
  if (/^[\d０-９]+(?:[.．]\d+)?$/.test(current.trim())) {
    lines.push(`「${current}」は${/温度/.test(previous) ? '温度（℃）' : /数量|何個/.test(previous) ? '数量（個・本など）' : /寸法|長さ/.test(previous) ? '寸法（mmなど）' : '何の数値'}でしょうか？意味と単位を教えてください。`);
  } else if (photoHelpRequested(current)) {
    lines.push(PHOTO_GUIDE);
  } else if (/資料.*(?:ない|ありません)|図面.*(?:ない|ありません)|型番.*(?:不明|わから|分から|なく|ない)|^(?:わかりません|分かりません|不明)/.test(said)) {
    if (!/用途|使[うい]|固定|交換|取り付|取付/.test(said))
      lines.push('型番が不明でも、用途から絞り込めます。どの機械の、何をする部品でしょうか？');
    else if (!/形状|[LＬコUＵ]字|丸|板状|筒|穴.*[数個つ]/.test(said))
      lines.push('その用途を手がかりにします。部品の形状や取り付け方を教えていただけますか？');
    else
      lines.push('伺った用途・形状だけでは商品を一意に特定できず、販売可否と在庫は未確認です。このチャットでは情報を整理できます。追加の表示や写真が見つかれば続けて確認できます。担当者への確認をご希望の場合はお問い合わせから相談内容を送れます（まだ送信していません）。');
  } else if (replies.some((r) => r.includes(IDENTIFICATION_QUESTION))) {
    lines.push('表示や資料がなければ用途・形状から絞り込めます。どのような部品で、何に使うものか教えてください。');
  } else lines.push(IDENTIFICATION_QUESTION);
  return [...new Set(lines)].join('\n');
}

export function oneMissingPoint(input: ComposeInput) {
  const points = pointStatus(input.topic, input.customerTexts);
  const open =
    points.find((p) => p.state === 'unknown') || points.find((p) => p.state === 'missing');
  const label = open?.label || '既設品のメーカー・型番';
  return `追加で確認したいのは「${label}」です。現物の表示や図面で確認できますか？不明な場合は、写真や分かる範囲の情報を担当者へお伝えください。\nこの条件だけでは適合を確定できません。${handoffGuide(input.handoff, input.guideLabel, input.phone)}`;
}

export function summarizeConsultation(input: ComposeInput) {
  const texts = input.allCustomerTexts || input.customerTexts;
  const statements = customerStatements(texts);
  const facts = keyFacts(texts, input.destination);
  // Every item discussed, such as "断熱材・ホース".
  const topics = [...new Set(texts.map((t) => consultationTopic([t])).filter(Boolean))];
  // Points still open are listed for a single item the customer described.
  const unknown =
    topics.length === 1
      ? pointStatus(topics[0], texts)
          .filter((p) => p.state !== 'known')
          .map((p) => p.label)
          .slice(0, 4)
      : [];
  const subject = topics.length
    ? topics.map(topicName).join('・')
    : input.label || topicName(input.topic);
  if (!statements.length)
    return `まだまとめるご相談内容がありません。お探しの物や用途を教えていただければ、お見積りに必要な内容を整理します。`;
  return [
    `ここまでに伺ったご相談内容です。${subject ? `（${subject}）` : ''}`,
    ...(facts.length ? [`伺った条件：${facts.join('・')}`] : []),
    ...statements.map((s) => `・${s}`),
    ...(unknown.length ? [`未確認：${unknown.join('、')}`] : []),
    handoffGuide(input.handoff, input.guideLabel, input.phone),
  ].join('\n');
}

// Text placed in the inquiry form when the customer moves to the staff.
export function handoffDraft(customerTexts: string[], summary?: string, destination?: string) {
  const statements = customerStatements(customerTexts);
  if (summary) return `【チャットでのご相談内容】\n${summary}`.slice(0, 2000);
  if (!statements.length) return '';
  const facts = keyFacts(customerTexts, destination);
  return [
    '【チャットでのご相談内容】',
    ...(facts.length ? [`伺った条件：${facts.join('・')}`] : []),
    ...statements.map((s) => `・${s}`),
  ]
    .join('\n')
    .slice(0, 2000);
}

// Public website content only.
export function companyFact() {
  return `${company.name}の事業: ${services.map((s) => `${s.name}（${s.description}）`).join(' ')} 主な実績: ${projects.map((p) => p.name).join('、')}。`;
}
