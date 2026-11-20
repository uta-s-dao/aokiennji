export const isTentative = (text: string) =>
  /仮に|ならどう|なら[？?]|候補として|としたら|まだ.{0,20}(?:決めて|未定)|(?:でき|可能).{0,6}(?:ますか|でしょうか|ですか)/.test(
    text,
  );

export function quoteContext(text: string, quote: string) {
  const clauses = (text.match(/[^。！？!?\n]+[。！？!?]?/g) ?? []).filter((c) =>
    c.includes(quote),
  );
  return clauses.length === 1 ? clauses[0].trim() : quote;
}

// Use the original sentence only as ownership evidence, never as a replacement
// for an attribute quote (which may need to contain exactly one number).
export function hasUniqueItemContext(
  text: string,
  quote: string,
  label: string,
  otherLabels: string[],
) {
  if (!quote || text.split(quote).length !== 2) return false;
  const context = quoteContext(text, quote);
  return (
    context.includes(label) &&
    !otherLabels.some((other) => context.includes(other))
  );
}

export const unsafeToRecover = (text: string) =>
  isTentative(text) ||
  /不要|不必要|しない|しません|ではな|じゃな|除外|除く|訂正|変更|以外|以上|以下|未満|超|約|程度|から|まで|[~～〜<>＜＞≠?？]|でしょうか|ですか|候補|旧型番|以前の型番|未確定|未定|不明|分かりません|わかりません|または|又は|もしくは|あるいは|かもしれ|かどうか|か[A-Za-z0-9]|どちら|いずれ|のような|同等|例えば|例として/.test(
    text,
  );

/** A named bore may qualify an explicit statement of hollow construction. */
export const hollowBore =
  /^(内径(?:は|[:：])?\s*[0-9]+(?:\.[0-9]+)?\s*(?:mm|cm|m))の(?:中空|空洞)(?:構造)?(?:で|です|でお願いします)?$/;

/** The structure must be an affirmative statement in its own right. */
export function explicitBodyStructure(
  quote: string,
): "hollow" | "solid" | null {
  const clause = quote.trim().replace(/[。！.!]$/, "");
  if (
    hollowBore.test(clause) ||
    /^(?:中(?:は|が))?(?:空洞(?:構造)?|中空(?:構造)?)(?:です|になります|になっています|でお願いします)?$/.test(
      clause,
    )
  )
    return "hollow";
  if (
    /^(?:(?:中(?:は|が))?(?:無垢(?:材)?|中実)(?:です|になります|でお願いします)?|中(?:は|が)詰まって(?:います|いる)|無垢（中は詰まっている）)$/.test(
      clause,
    )
  )
    return "solid";
  return null;
}

export function groundedBodyStructure(
  text: string,
  quote: string,
): "hollow" | "solid" | null {
  if (
    isTentative(text) ||
    /[?？]|もし|かどうか|または|又は|あるいは|もしくは|それとも|どちら/.test(
      text,
    ) ||
    /(?:無垢|中実|中空|空洞)(?:材|構造)?(?:か|なら|だったら|のとき|ではなく|じゃなく|でない場合)/.test(
      text,
    )
  )
    return null;
  const clauses = text.split(/[。、，,！!\n]+/);
  const matching = clauses.filter((clause) => clause.includes(quote));
  if (matching.length !== 1) return null;
  const structureOf = (clause: string) =>
    explicitBodyStructure(clause.trim().replace(/^[「『]|[」』]$/g, ""));
  const body = structureOf(matching[0]);
  if (body === "solid" && /内径(?:は|[:：])?\s*[0-9０-９]/.test(text))
    return null;
  if (
    clauses.some((clause) => {
      const other = structureOf(clause);
      return other !== null && other !== body;
    })
  )
    return null;
  return body;
}

const holeLayoutName = /穴(?:の)?(?:位置|配置|ピッチ)|穴間隔|ピッチ|PCD/i;
const holeLocation =
  /四隅|両端|片側|左右|上下|対角|等間隔|均等|中心|端から|隅から|千鳥|格子|同心円|円周上|周囲|上面|下面|側面|対面|原点|オフセット|座標|[xXＸｘ][\s=:：＝]*[0-9０-９]|[0-9０-９]+(?:[.．][0-9０-９]+)?\s*(?:mm|cm|ｍｍ|㎜|°|度)間隔/;
const holeMeasurement =
  /[0-9０-９]+(?:[.．][0-9０-９]+)?\s*(?:mm|cm|ｍｍ|㎜|°|度)|PCD\s*[φΦ]?\s*[0-9０-９]+/i;

export function explicitHoleLayout(quote: string, direct = false) {
  const clause = quote.trim().replace(/[。！.!]$/, "");
  if (
    !clause ||
    clause.length > 300 ||
    isTentative(clause) ||
    /仮|予定|未定|不要|しない|しません|ではな[いく]|ではありません|じゃな[いく]|不明|分から|わから|どちら|または|あるいは|[?？]/.test(
      clause,
    )
  )
    return null;
  if (
    holeLayoutName.test(clause) &&
    (holeLocation.test(clause) || holeMeasurement.test(clause))
  )
    return clause;
  if (
    holeLocation.test(clause) &&
    (direct ||
      /(?:四隅|等間隔|対角|円周上)(?:に|へ).{0,10}穴|穴.{0,8}(?:四隅|等間隔|対角|円周上)/.test(
        clause,
      ))
  )
    return clause;
  return null;
}

export function attributeClause(text: string, quote: string) {
  const quoteWithoutEnd = quote.trim().replace(/[。！？!?]+$/, "");
  const clauses = text
    .split(/[。、，,！？!?\n]+/)
    .filter((clause) => clause.includes(quoteWithoutEnd));
  return clauses.length === 1 ? clauses[0].trim() : quote;
}

export const ambiguousCapacity = (clause: string) =>
  /約|程度|未満|以下|以上|超|から|まで|[~～〜<>＜＞]|ではない|ではありません|じゃない|または|あるいは|もしくは|未定|不明|(?:mL|L|リッ(?:トル|ター))(?:か|又は)/i.test(
    clause,
  );

export const drillingOperation = /(?:穴|孔)(?:を)?(?:あけ|開け|加工)/;
const ownedDrilling =
  /^(?<owned>(?:手持ちの|手元にある|手元の|当方所有の)(?<item>[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9ー-]{1,40}))に\s*(?<operation>(?:穴|孔)(?:を)?(?:あけ加工|開け加工|あけ|開け|加工))(?:てほしい(?:です)?|てください|(?:を)?お願いします|してください)$/u;

export function ownedDrillingRequest(text: string) {
  const clause = text
    .trim()
    .replace(/^[「『]|[」』]$/g, "")
    .replace(/[。！.!]$/, "");
  const groups = clause.match(ownedDrilling)?.groups;
  if (
    !groups ||
    unsafeToRecover(clause) ||
    /塗料|ペンキ|及|別途|各種|複数/.test(groups.item)
  )
    return null;
  return {
    item: groups.item,
    owned: groups.owned,
    operation: groups.operation,
  };
}
