import { beforeEach, afterAll } from 'vitest';
import { resetDbForTests } from '../lib/server/db';
import { resetLocalDatabase } from './database-fixtures';
beforeEach(resetLocalDatabase);
afterAll(resetDbForTests);
