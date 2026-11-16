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
