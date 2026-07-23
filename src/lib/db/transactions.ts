import mongoose, { type ClientSession } from 'mongoose';

let supportsTxCache: boolean | null = null;

const probeTransactions = async (): Promise<boolean> => {
  try {
    const db = mongoose.connection.db;
    if (!db) return false;
    const info = (await db.admin().command({ hello: 1 })) as {
      setName?: string;
      msg?: string;
    };
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

export const resetTransactionSupportCache = () => {
  supportsTxCache = null;
};

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
