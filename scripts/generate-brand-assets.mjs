// Resize the approved emblem and typeset the company's exact name for sharing.
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
const master = 'public/images/brand/emblem-master.png';
await sharp(master).resize(512, 512).png().toFile('app/icon.png');
await sharp(master).resize(180, 180).png().toFile('app/apple-icon.png');
const png = await sharp(master).resize(48, 48).ensureAlpha().png().toBuffer();
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 48;
ico[7] = 48;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
await writeFile('app/favicon.ico', Buffer.concat([ico, png]));
const logo = await sharp(master).resize(254, 254).toBuffer();
const fontfile = 'public/fonts/zen-kaku-gothic-new-bold.ttf';
const text = async (value, size, color, width) =>
  sharp({
    text: {
      text: `<span foreground="${color}">${value}</span>`,
      font: `Zen Kaku Gothic New Bold ${size}`,
      fontfile,
      rgba: true,
      ...(width ? { width } : {}),
    },
  })
    .png()
    .toBuffer();
const name = await text('アオキエンジ株式会社', 52, '#172f49');
const english = await text('AOKI ENG CO., LTD.', 24, '#52708d');
const description = await text('鋼構造物・機械装置の設計・製作・据付', 27, '#34516c');
const location = await text('北九州・福岡', 22, '#52708d');
const stripe = await sharp({
  create: { width: 1200, height: 12, channels: 3, background: '#1558a6' },
})
  .png()
  .toBuffer();
await sharp({ create: { width: 1200, height: 630, channels: 3, background: '#ffffff' } })
  .composite([
    { input: logo, left: 68, top: 170 },
    { input: name, left: 355, top: 215 },
    { input: english, left: 358, top: 290 },
    { input: description, left: 112, top: 460 },
    { input: location, left: 112, top: 514 },
    { input: stripe, left: 0, top: 618 },
  ])
  .png()
  .toFile('public/images/brand/company-share.png');
