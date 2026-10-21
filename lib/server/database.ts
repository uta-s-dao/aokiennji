import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';

// The server is the only database client. There is no SQLite fallback.
const transactions = new AsyncLocalStorage<postgres.TransactionSql>();
export type HyperdriveBinding = { connectionString: string };
type ConnectionState = { pool?: postgres.Sql; hyperdrive?: HyperdriveBinding };
const requestConnections = new AsyncLocalStorage<ConnectionState>();
const processConnection: ConnectionState = {};
function connectionState() {
  return requestConnections.getStore() || processConnection;
}
// Workers sockets belong to the request that opened them, so each HTTP request
// has its own lazily created pool. Node servers retain their process pool.
export function createDatabaseScope(hyperdrive?: HyperdriveBinding) {
  const state: ConnectionState = { hyperdrive };
  return {
    run<T>(body: () => T): T {
      return requestConnections.run(state, body);
    },
    async close() {
      const pool = state.pool;
      state.pool = undefined;
      await pool?.end({ timeout: 5 });
    },
  };
}
function connection() {
  const state = connectionState();
  if (state.pool) return state.pool;
  const url = state.hyperdrive?.connectionString || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required; SQLite fallback is disabled');
  const target = new URL(url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  if (!state.hyperdrive && !local && globalThis.navigator?.userAgent === 'Cloudflare-Workers')
    throw new Error('HYPERDRIVE binding is required for remote databases on Workers');
  if (!state.hyperdrive && !local && target.searchParams.get('sslmode') === 'disable')
    throw new Error('Remote database connections require verified TLS');
  state.pool = postgres(url, {
    prepare: !!state.hyperdrive,
    fetch_types: false,
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    // Hyperdrive is a trusted platform binding; origin TLS is verify-full with
    // the Supabase CA in its configuration. Direct remote URLs still require TLS.
    ssl: state.hyperdrive || local ? false : 'verify-full',
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
  return state.pool;
}
// Static server SQL uses positional ? parameters; quoted literals are untouched.
function parameters(query: string) {
  let n = 0;
  return query.replace(/'(?:''|[^'])*'|\?/g, (part) => (part === '?' ? `$${++n}` : part));
}
export const database = {
  prepare(query: string) {
    const execute = (...values: any[]) =>
      (transactions.getStore() || connection()).unsafe(parameters(query), values, {
        prepare: !!connectionState().hyperdrive,
      });
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
  // Keep a transaction-level advisory lock on a separate pooled connection.
  // Work commits independently: provider sends must not roll back their saved payloads.
  async exclusiveJob<T>(
    body: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    if (transactions.getStore()) throw new Error('Jobs cannot run inside a transaction');
    return connection().begin(async (guard) => {
      await guard`SET LOCAL idle_in_transaction_session_timeout = 0`;
      const [row] =
        await guard`SELECT pg_try_advisory_xact_lock(hashtextextended('aoki:maintenance',0)) AS locked`;
      if (!row.locked) return { acquired: false as const };
      return { acquired: true as const, value: await body() };
    }) as Promise<{ acquired: false } | { acquired: true; value: T }>;
  },
  async close() {
    const state = connectionState();
    const old = state.pool;
    state.pool = undefined;
    await old?.end({ timeout: 5 });
  },
};
export async function lockResource(key: string) {
  if (!transactions.getStore()) throw new Error('Resource locks require a transaction');
  await database.prepare('SELECT pg_advisory_xact_lock(hashtextextended(?,0))').get(key);
}
