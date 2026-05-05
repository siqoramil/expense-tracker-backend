import mongoose, { type ClientSession } from 'mongoose';

// MongoDB transactions need a replica set or a sharded cluster — they fail on
// a standalone `mongod`, which is the default dev setup. We probe the topology
// once on first use and fall back to non-transactional writes when needed.
//
// Production deployments SHOULD run a replica set (even single-node `rs0`)
// so writes remain atomic. The fallback is a developer-ergonomics escape
// hatch, not a correctness guarantee.
let supportsTxCache: boolean | null = null;

const probeTransactions = async (): Promise<boolean> => {
  try {
    const db = mongoose.connection.db;
    if (!db) return false;
    const info = (await db.admin().command({ hello: 1 })) as {
      setName?: string;
      msg?: string;
    };
    // `setName` => replica set member; `msg: 'isdbgrid'` => mongos router.
    return Boolean(info.setName) || info.msg === 'isdbgrid';
  } catch {
    return false;
  }
};

export const supportsTransactions = async (): Promise<boolean> => {
  if (supportsTxCache !== null) return supportsTxCache;
  supportsTxCache = await probeTransactions();
  return supportsTxCache;
};

// For tests that flip between deployments.
export const resetTransactionSupportCache = () => {
  supportsTxCache = null;
};

// Run `fn` inside a transaction when supported, otherwise run it without a
// session. Callers must accept `session: ClientSession | null` and pass it
// through to all mongoose ops.
export const withMaybeTransaction = async <T>(
  fn: (session: ClientSession | null) => Promise<T>,
): Promise<T> => {
  if (!(await supportsTransactions())) {
    return fn(null);
  }
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};
