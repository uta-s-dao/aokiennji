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
