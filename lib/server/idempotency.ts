import { createHash } from 'node:crypto';
import { db, lockResource } from './db';
import { ApiError } from './auth';

export async function once<T>(
  scope: string,
  key: string | null,
  input: unknown,
  action: () => Promise<T>,
): Promise<T> {
  if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key))
    throw new ApiError(400, 'idempotency_required', '受付キーが必要です。再読み込みしてください。');
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return await db().transaction(async () => {
    await lockResource(`request:${scope}:${key}`);
    const old = await db()
      .prepare('SELECT request_hash,response FROM request_keys WHERE scope=? AND key=?')
      .get(scope, key);
    if (old) {
      if (old.request_hash !== hash)
        throw new ApiError(
          409,
          'idempotency_conflict',
          '同じ受付キーで異なる内容は送信できません。',
        );
      return JSON.parse(old.response) as T;
    }
    const result = await action();
    await db()
      .prepare('INSERT INTO request_keys(scope,key,request_hash,response) VALUES(?,?,?,?)')
      .run(scope, key, hash, JSON.stringify(result));
    return result;
  })();
}
