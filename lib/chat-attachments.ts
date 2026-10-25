/** Shared picker rules; the server also checks the actual file contents. */
export const CHAT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';
export const CHAT_FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
};
export const CHAT_FILE_ACCEPT = Object.keys(CHAT_FILE_TYPES)
  .map((ext) => `.${ext}`)
  .join(',');
export function chatAttachmentError(file: { size: number; type: string; name: string }) {
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES)
    return 'ファイルが5MBを超えています。5MB以下のファイルを選んでください。';
  if (!file.size) return '空のファイルは添付できません。';
  if (
    !CHAT_PHOTO_ACCEPT.split(',').includes(file.type) &&
    !Object.hasOwn(CHAT_FILE_TYPES, file.name.split('.').pop()?.toLowerCase() || '')
  )
    return '写真（JPEG・PNG・WebP）、PDF、Word（.docx）、Excel（.xlsx）、テキスト、CSVを選んでください。';
  return '';
}
