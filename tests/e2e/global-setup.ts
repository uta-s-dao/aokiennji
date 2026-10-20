import { resetLocalDatabase } from '../database-fixtures';
import { resetDbForTests } from '../../lib/server/db';
export default async function setup() {
  await resetLocalDatabase();
  await resetDbForTests();
}
