// Historical simulation tools clone SQLite using DATA_DIR, which cannot isolate
// today's Postgres runtime. Refuse execution before any database/API mutation.
throw new Error(
  'This SQLite snapshot harness is retired after UTA-8. Use npm run test:db / test:e2e:db against the isolated local Supabase.',
);
export {};
