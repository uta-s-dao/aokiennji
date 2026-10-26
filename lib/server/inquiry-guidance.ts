import type { ProductInquiryState } from '../contracts';

export function informationQuestion(text: string) {
  return /用途|特徴|材質|特性|仕様|使い分け|適用範囲|使用温度|使用圧力|どんな製品|どのような製品|何の製品|何を密封|何に使|何に用|選び|選ぶ|選定|候補|確認.*(?:条件|項目)|チェック項目|必要な(?:情報|条件)|何を確認/.test(
    text,
  );
}
export function companyQuestion(text: string) {
  return (
    /^(?:会社概要|所在地|住所|どんな会社|どのような会社)/.test(text) ||
    /^(?:会社|事業|業務)(?:の|について|は).*(?:所在地|住所|事業|業務|仕事|何|どこ)/.test(text) ||
    /(?:アオキエンジ|御社|そちら|この会社).*(?:どこ|どんな仕事|どのような仕事|事業|何をして|何を扱|会社|所在地|住所)/.test(
      text,
    ) ||
    /(?:図面|設計).*(?:製作|据付).*(?:相談|対応|お願い)/.test(text)
  );
}
export function summaryQuestion(text: string) {
  return (
    /(?:現在|いま|今|訂正後|希望|条件|内容).*(?:まとめて|復唱|要約)|(?:まとめて|復唱|要約).*(?:条件|希望)/.test(
      text,
    ) && !/必要な情報|整理しておく|チェック項目/.test(text)
  );
}
const dimensionFields = [
  ['呼び径', /(?<![A-Za-z0-9])(\d+\s*A)\b/i],
  ['内径', /内径\s*[は：:]?\s*(\d+(?:\.\d+)?\s*(?:mm|cm|ミリ|センチ))/i],
  ['外径', /外径\s*[は：:]?\s*(\d+(?:\.\d+)?\s*(?:mm|cm|ミリ|センチ))/i],
  ['厚さ', /(?:厚さ|厚み|板厚)\s*(?:だけ|は|を|：|:)?\s*(\d+(?:\.\d+)?\s*(?:mm|cm|ミリ|センチ))/i],
  ['幅', /幅\s*[は：:]?\s*(\d+(?:\.\d+)?\s*(?:mm|cm|ミリ|センチ))/i],
  ['高さ', /高さ\s*[は：:]?\s*(\d+(?:\.\d+)?\s*(?:mm|cm|ミリ|センチ))/i],
  ['角寸法', /(\d+(?:\.\d+)?\s*(?:mm|cm|ミリ|センチ)角)/i],
] as const;
export function updateConditions(state: ProductInquiryState, text: string) {
  const normalized = text.normalize('NFKC');
  state.specifications ||= {};
  for (const [key, re] of dimensionFields) {
    const matches = [...normalized.matchAll(new RegExp(re.source, 'gi'))];
    if (matches.length) {
      const correction = normalized
        .slice(matches.at(-1)!.index! + matches.at(-1)![0].length)
        .match(/^から\s*(\d+(?:\.\d+)?\s*(?:mm|cm|ミリ|センチ))/i);
      state.specifications[key] = correction?.[1] || matches.at(-1)![1];
    }
  }
  const material = normalized.match(/\b(?:PTFE|SUS\s*\d{3}[A-Z]*|EPDM|NBR|FKM)\b/i)?.[0];
  if (material) state.material = material;
  const temperature = normalized.match(/(-?\d+(?:\.\d+)?\s*(?:℃|°C|度))/i)?.[1];
  if (temperature) state.specifications['使用温度'] = temperature;
  if (Object.keys(state.specifications).length)
    state.dimensions = Object.entries(state.specifications)
      .map(([k, v]) => `${k}${v}`)
      .join('・');
}
export function currentInquiryFacts(state: ProductInquiryState) {
  return [
    state.designation && `商品名：${state.designation}`,
    state.model && `型番：${state.model}`,
    state.manufacturer && `メーカー：${state.manufacturer}`,
    state.material && `材質：${state.material}`,
    state.purpose &&
      !/\d\s*(?:mm|cm|ミリ|センチ|℃|°C)/i.test(state.purpose) &&
      `用途：${state.purpose}`,
    state.shape && !/\d\s*(?:mm|cm|ミリ|センチ|℃|°C)/i.test(state.shape) && `形状：${state.shape}`,
    state.dimensions && `仕様：${state.dimensions}`,
    state.quantity && `数量：${state.quantity}${state.quantityUnit || '（単位未確認）'}`,
    state.destination && `お届け先：${state.destination}`,
  ]
    .filter(Boolean)
    .join('・');
}
export function selectionGuidance(
  state: ProductInquiryState,
  text: string,
  productNames: string[] = [],
) {
  const subject = [state.designation, state.purpose, state.shape, ...productNames, text]
    .filter(Boolean)
    .join(' ');
  const points = /ガラス|窓/.test(subject)
    ? [
        '連続使用温度・最高温度と加熱冷却の速さ',
        '窓の寸法・厚さと取付方法、圧力の有無',
        '接触する雰囲気・薬品と必要な透明性',
      ]
    : /ガスケット|パッキン|シール|PTFE/.test(subject)
      ? [
          '接触する流体・薬品の名称と濃度',
          '連続・最高使用温度と圧力',
          '内径・外径・厚さ、フランジ規格と締付条件',
        ]
      : [
          '用途と接触する物・使用環境',
          '形状・寸法と取付方法',
          '使用温度・荷重や圧力などの運転条件',
        ];
  const general =
    /用途|何を密封|何に使/.test(text) && /ガスケット|パッキン/.test(subject)
      ? 'ガスケット一般は、配管・機器などの接合面を密封し、流体や気体の漏れを防ぐための部材です。個別製品の使用流体・温度・圧力は製品ごとに異なります。'
      : '';
  const comparison = /薬品|耐薬品|ゴム|使い分け/.test(text)
    ? '薬品への使い分けは、PTFEやゴムという材質名だけでは判断できません。薬品名・混合物の成分・濃度・温度・接触時間をそろえ、各製品・ゴム材種の耐薬品性表を比較します。洗浄薬剤、膨潤・劣化、必要な密封性と締付条件も照合してください。表の条件が一致しない場合はメーカーへの確認が必要です。'
    : '';
  const dimensional =
    !state.designation &&
    !state.model &&
    Object.keys(state.specifications || {}).length &&
    /寸法.*(?:選べ|製品|商品|探)|(?:選べ|製品|商品).*寸法/.test(text)
      ? 'ご指定の寸法に一致する標準品・加工対応品は、まだ確認できていません。標準寸法表と図面を照合し、標準品にない場合は打抜き・切断加工の可否、寸法公差、必要数量を確認する必要があります。'
      : '';
  return `${dimensional}${comparison}${general}選定では、${points.map((p, i) => `${i + 1}. ${p}`).join('、')}を照合します。${currentInquiryFacts(state) ? `伺った条件は、${currentInquiryFacts(state)}です。` : ''}分かっている条件は再提出不要です。不明な項目を推測して埋める必要はありません。これらだけで個別製品の適合を確定せず、製品資料の適用範囲と照合します。`;
}
