import { beforeEach, afterAll, vi } from 'vitest';
import { resetDbForTests } from '../lib/server/db';
import { resetLocalDatabase } from './database-fixtures';
beforeEach(resetLocalDatabase);
beforeEach(() => {
  // Explicit synthetic contract ceiling for mocked Jev responses, never a live tariff.
  vi.stubEnv('AI_JEV_MAX_CALL_USD', '0.01');
  vi.stubEnv('AI_JEV_PRICE_VERSION', 'test-fixture-only');
  vi.stubEnv('STRIPE_SECRET_KEY', '');
  vi.stubEnv('BILLING_REQUIRED', 'false');
  vi.stubEnv('RESEND_API_KEY', '');
});
afterAll(resetDbForTests);
