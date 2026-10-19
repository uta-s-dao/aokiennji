// Japanese supplier sites still serve Shift_JIS and EUC-JP. Decode before
// extracting text or metadata, so stock and shipping qualifiers remain intact.
export function decodeHtml(body: Buffer, contentType: string | null): string {
  const head = body.subarray(0, 4096).toString('latin1');
  const charset = (
    /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '')?.[1] ||
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ||
    'utf-8'
  ).toLowerCase();
  const label = /shift[_-]?jis|sjis|windows-31j|cp932/.test(charset)
    ? 'shift_jis'
    : /euc-?jp/.test(charset)
      ? 'euc-jp'
      : 'utf-8';
  return new TextDecoder(label).decode(body);
}
