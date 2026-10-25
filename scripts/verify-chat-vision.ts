import assert from 'node:assert/strict';
// Local-only synthetic image smoke test. Never imports production DB settings.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { resetLocalDatabase } from '../tests/database-fixtures';
import { putSettings, resetDbForTests } from '../lib/server/db';
import { DEFAULT_SETTINGS } from '../lib/contracts';
import { uploadChatImage } from '../lib/server/chat-images';
import { answerChat } from '../lib/server/chat';

async function main() {
  if (
    !process.env.DATABASE_URL ||
    !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)
  )
    throw Error('Local DB required');
  // Prefer an explicitly scoped environment key; local developer env is a fallback.
  const keyLine = readFileSync('.env.local', 'utf8')
    .split('\n')
    .find((s) => s.startsWith('OPENAI_API_KEY='));
  process.env.OPENAI_API_KEY ||=
    keyLine
      ?.slice('OPENAI_API_KEY='.length)
      .trim()
      .replace(/^['"]|['"]$/g, '') || '';
  if (!process.env.OPENAI_API_KEY) throw Error('OpenAI key missing');
  process.env.DEMO_MODE = 'true';
  process.env.RESEND_API_KEY = '';
  process.env.STRIPE_SECRET_KEY = '';
  process.env.BILLING_REQUIRED = 'false';
  await resetLocalDatabase();
  await putSettings({
    ...DEFAULT_SETTINGS,
    responseProvider: 'openai',
    responseModel: 'gpt-4.1-mini',
    flags: {
      ...DEFAULT_SETTINGS.flags,
      webSearch: false,
      aiResearch: false,
      orders: false,
      autoQuote: false,
    },
  });
  const directory = '/tmp/aoki-vision-verification';
  mkdirSync(directory, { recursive: true });
  const fixtures = [
    {
      name: 'box',
      lines: ['PACKAGE LABEL', 'MANUFACTURER: AOKI', 'MODEL: DEMO-GLASS-01', 'QTY: 10'],
      message: '箱のラベルです。この商品を扱っていますか？',
    },
    {
      name: 'drawing',
      lines: [
        'DRAWING NO: DRAW-100',
        'PART A: BRACKET / PART NO: P-10',
        'PART B: PLATE / PART NO: P-20',
      ],
      message: 'この図面の部品を探しています。',
    },
    {
      name: 'tag',
      lines: ['MANUFACTURER: NSK', 'MODEL: 6205ZZ'],
      message: 'タグの型番を読めますか？',
    },
    {
      name: 'blurred',
      lines: ['MANUFACTURER: NSK', 'MODEL: 6205ZZ'],
      message: 'タグがぼやけています。読めますか？',
    },
  ];
  const results = [];
  for (const fixture of fixtures) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><rect width="1000" height="500" fill="#fff"/><rect x="15" y="15" width="970" height="470" fill="none" stroke="#222"/>${fixture.lines.map((line, i) => `<text x="50" y="${90 + i * 95}" fill="#111" font-family="sans-serif" font-size="38">${line}</text>`).join('')}</svg>`;
    const pipeline = sharp(Buffer.from(svg));
    const bytes = await (fixture.name === 'blurred' ? pipeline.blur(25) : pipeline)
      .png()
      .toBuffer();
    writeFileSync(`${directory}/${fixture.name}.png`, bytes);
    const image = await uploadChatImage(bytes, 'vision-verification');
    const answer = await answerChat(fixture.message, 'vision-verification', image.conversationId, {
      attachmentIds: [image.id],
    });
    results.push({ fixture: fixture.name, reply: answer.message });
  }
  writeFileSync(`${directory}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    results.map((r) => ({
      fixture: r.fixture,
      provider: r.reply.responseProvider,
      content: r.reply.content,
      candidates: r.reply.inquiryState?.imageCandidates,
    })),
  );
  for (const result of results) {
    assert.equal(result.reply.responseProvider, 'openai', 'A live vision response is required');
    const candidates = result.reply.inquiryState?.imageCandidates || [];
    if (result.fixture === 'box')
      assert(candidates.some((c) => c.value === 'DEMO-GLASS-01' && c.kind === 'order_model'));
    if (result.fixture === 'tag')
      assert(candidates.some((c) => c.value === '6205ZZ' && c.kind === 'order_model'));
    if (result.fixture === 'drawing') {
      assert(candidates.length >= 2);
      assert(candidates.every((c) => c.kind !== 'order_model'));
    }
    if (result.fixture === 'blurred')
      assert(
        candidates.every((c) => !c.readable || !c.value),
        'Blurred text must not be invented',
      );
  }
  console.log('PASS: live synthetic box, tag, multi-part drawing and blurred image');
  await resetDbForTests();
}
main().catch(async () => {
  console.error('Synthetic vision verification failed; no credentials logged');
  await resetDbForTests();
  process.exitCode = 1;
});
