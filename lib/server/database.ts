import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';

// The server is the only database client. There is no SQLite fallback.
const transactions = new AsyncLocalStorage<postgres.TransactionSql>();
let pool: postgres.Sql | undefined;
function connection() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required; SQLite fallback is disabled');
  const target = new URL(url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  if (!local && target.searchParams.get('sslmode') === 'disable')
    throw new Error('Remote database connections require verified TLS');
  pool = postgres(url, {
    prepare: false,
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: local ? false : 'verify-full',
    connection: { search_path: 'app_private,public', application_name: 'aokiennji' },
    onnotice: () => {},
    types: {
      timestamps: {
        to: 1184,
        from: [1184],
        serialize: (v: string) => v,
        parse: (v: string) => new Date(v).toISOString(),
      },
    },
  });
  return pool;
}
// Static server SQL uses positional ? parameters; quoted literals are untouched.
function parameters(query: string) {
  let n = 0;
  return query.replace(/'(?:''|[^'])*'|\?/g, (part) => (part === '?' ? `$${++n}` : part));
}
export const database = {
  prepare(query: string) {
    const execute = (...values: any[]) =>
      (transactions.getStore() || connection()).unsafe(parameters(query), values);
    return {
      async all(...values: any[]): Promise<any[]> {
        return [...(await execute(...values))];
      },
      async get(...values: any[]): Promise<any> {
        return (await execute(...values))[0];
      },
      async run(...values: any[]) {
        const result = await execute(...values);
        return { changes: result.count };
      },
      async iterate(...values: any[]): Promise<any[]> {
        return [...(await execute(...values))];
      },
    };
  },
  async exec(query: string) {
    await (transactions.getStore() || connection()).unsafe(query);
  },
  transaction<T>(body: () => T | Promise<T>) {
    return async (): Promise<T> => {
      const active = transactions.getStore();
      if (active) return active.savepoint((tx) => transactions.run(tx, body)) as Promise<T>;
      return connection().begin((tx) => transactions.run(tx, body)) as Promise<T>;
    };
  },
  async close() {
    const old = pool;
    pool = undefined;
    await old?.end({ timeout: 5 });
  },
};
export async function lockResource(key: string) {
  if (!transactions.getStore()) throw new Error('Resource locks require a transaction');
  await database.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))').get(key);
}
