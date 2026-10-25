import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import { CHAT_ATTACHMENT_MAX_BYTES, chatAttachmentError } from '../lib/chat-attachments';
import {
  validateChatAttachment,
  uploadChatImage,
  readChatImage,
  chatAttachmentInputs,
} from '../lib/server/chat-images';

it('accepts exactly 5MB and rejects a larger file before upload', async () => {
  const file = { name: 'document.txt', type: 'text/plain', size: CHAT_ATTACHMENT_MAX_BYTES };
  expect(chatAttachmentError(file)).toBe('');
  expect(chatAttachmentError({ ...file, name: 'unsupported.constructor', type: 'application/octet-stream' })).not.toBe('');
  expect(chatAttachmentError({ ...file, size: file.size + 1 })).toContain('5MBを超え');
  await expect(
    validateChatAttachment(Buffer.alloc(file.size + 1), file.name, file.type),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    validateChatAttachment(Buffer.from('fake PDF'), 'fake.pdf', 'application/pdf'),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    validateChatAttachment(Buffer.from('executable'), 'app.exe', 'application/octet-stream'),
  ).rejects.toMatchObject({ status: 400 });
});
it('preserves private document bytes and filename, extracts text, and enforces ownership and conversation', async () => {
  const bytes = Buffer.from('商品型番 DEMO-GLASS-01、数量2枚');
  const uploaded = await uploadChatImage(
    bytes,
    'customer-a',
    undefined,
    '../図面メモ.txt',
    'text/plain',
  );
  const own = await readChatImage(uploaded.id, 'customer-a');
  expect(own.bytes).toEqual(bytes);
  expect(own.fileName).toBe('図面メモ.txt');
  expect(own.contentType).toBe('text/plain');
  const inputs = await chatAttachmentInputs([uploaded.id], uploaded.conversationId, 'customer-a');
  expect(inputs.images).toEqual([]);
  expect(inputs.documents.join('')).toContain('DEMO-GLASS-01');
  await expect(readChatImage(uploaded.id, 'customer-b')).rejects.toMatchObject({ status: 403 });
  await expect(
    chatAttachmentInputs([uploaded.id], 'other-conversation', 'customer-a'),
  ).rejects.toMatchObject({ status: 403 });
  expect((await readChatImage(uploaded.id, null, true)).fileName).toBe('図面メモ.txt');
});
it('keeps existing photo input working and strips metadata by re-encoding', async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  const uploaded = await uploadChatImage(png, 'photo-owner');
  const inputs = await chatAttachmentInputs([uploaded.id], uploaded.conversationId, 'photo-owner');
  expect(inputs.images[0]).toMatch(/^data:image\/webp;base64,/);
  expect(inputs.documents).toEqual([]);
});
it('extracts PDF, Word and Excel documents and retains scanned PDFs for staff', async () => {
  for (const ext of ['pdf', 'docx']) {
    const attachment = await validateChatAttachment(
      readFileSync(`tests/fixtures/catalog.${ext}`),
      `catalog.${ext}`,
      'application/octet-stream',
    );
    expect(attachment.text.length).toBeGreaterThan(0);
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('部品');
  sheet.addRows([
    ['型番', '数量'],
    ['ABC-123', 2],
  ]);
  const excel = await validateChatAttachment(
    Buffer.from(await workbook.xlsx.writeBuffer()),
    'parts.xlsx',
    'application/octet-stream',
  );
  expect(excel.text).toContain('ABC-123');
  const scanned = await validateChatAttachment(
    readFileSync('tests/fixtures/scanned.pdf'),
    'scan.pdf',
    'application/pdf',
  );
  expect(scanned.text).toBe('');
  expect(scanned.bytes.length).toBeGreaterThan(0);
});
