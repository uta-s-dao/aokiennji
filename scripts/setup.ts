import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
if (existsSync('.env.local')) {
  console.log('.env.local は既にあります。上書きしません。');
} else {
  const password = randomBytes(20).toString('base64url'),
    salt = randomBytes(16);
  const hash = `scrypt$${salt.toString('base64url')}$${scryptSync(password, salt, 64).toString('base64url')}`;
  writeFileSync(
    '.env.local',
    `APP_ORIGIN=http://localhost:3000\nDATABASE_URL=\nDEMO_MODE=true\nALLOW_LIVE_ORDERS=false\nADMIN_PASSWORD_HASH='${hash.replaceAll('$', '\\$')}'\nSESSION_SECRET=${randomBytes(48).toString('base64url')}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    '.local-admin.txt',
    `アオキエンジ ローカル開発用ログイン\nURL: http://localhost:3000/admin\nPassword: ${password}\n外部には共有しないでください。\n`,
    { mode: 0o600 },
  );
  console.log(
    '初期設定を作成しました。管理パスワード: .local-admin.txt / docs/DATABASE_MIGRATION.md に沿ってローカルDBを設定してください。',
  );
}
console.log(
  'AI接続は docs/AI_SETUP.md を参照してください。Jev用 TYPESAFE_API_KEY と回答生成用 OPENAI_API_KEY を設定し、管理画面で接続を確認します。',
);
