export const modelIdentity = (value: string) =>
  value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s_‐‑–—−-]/g, '');

export function exactModelOnPage(model: string, text: string) {
  const parts = model.normalize('NFKC').match(/[A-Za-z0-9]+/g);
  if (!parts?.length) return false;
  return new RegExp(
    `(?<![A-Za-z0-9])${parts.join('[-_\\s]*')}(?![A-Za-z0-9]|[-_][A-Za-z0-9])`,
    'i',
  ).test(text.normalize('NFKC'));
}
