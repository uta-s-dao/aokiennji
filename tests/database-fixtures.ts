import { db, seedDemoData } from '../lib/server/db';
import { DEFAULT_SETTINGS } from '../lib/contracts';
import { DEFAULT_SITE_CONTENT } from '../lib/site-content';

export async function resetLocalDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
    throw new Error('Tests require explicitly configured local Supabase');
  await db().exec(
    `DO $$ DECLARE t record; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='app_private' LOOP EXECUTE format('TRUNCATE app_private.%I RESTART IDENTITY CASCADE',t.tablename); END LOOP; END $$`,
  );
  await db()
    .prepare('INSERT INTO settings(id,json) VALUES(1,?)')
    .run(JSON.stringify(DEFAULT_SETTINGS));
  const initial = JSON.stringify(DEFAULT_SITE_CONTENT);
  await db()
    .prepare('INSERT INTO site_content(id,revision,draft,published) VALUES(1,0,?,?)')
    .run(initial, initial);
  const previous = process.env.DEMO_MODE;
  process.env.DEMO_MODE = 'true';
  try {
    await seedDemoData();
  } finally {
    if (previous === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previous;
  }
}
