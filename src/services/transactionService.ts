import { NotFoundError } from '../core/errors.js';
import { withMaybeTransaction } from '../lib/db-tx.js';
import { categoryRepository } from '../repositories/categoryRepository.js';
import { transactionRepository } from '../repositories/transactionRepository.js';
import { walletRepository } from '../repositories/walletRepository.js';

type TxBody = {
  kind: 'income' | 'expense';
  cat: string;
  wallet: string;
  amount: number;
  note?: string;
  date: string;
};

// Signed balance effect of a transaction: income adds, expense subtracts.
const delta = (kind: 'income' | 'expense', amount: number) =>
  kind === 'income' ? amount : -amount;

// [gte, lt) date range covering a YYYY-MM month, used for filtering and stats.
export const monthRange = (month: string): { gte: string; lt: string } => {
  const [y, m] = month.split('-').map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    gte: `${y}-${String(m).padStart(2, '0')}-01`,
    lt: `${nextY}-${String(nextM).padStart(2, '0')}-01`,
  };
};

export const transactionService = {
  list(userId: string, opts: { month?: string; kind?: 'income' | 'expense'; limit: number }) {
    return transactionRepository.list(userId, {
      range: opts.month ? monthRange(opts.month) : undefined,
      kind: opts.kind,
      limit: opts.limit,
    });
  },

  // Create + balance adjustment run in one transaction so a failed ownership
  // check never leaves a half-applied $inc behind.
  create(userId: string, body: TxBody) {
    return withMaybeTransaction(async (session) => {
      const categoryExists = await categoryRepository.existsForUser(body.cat, userId);
      if (!categoryExists) throw new NotFoundError('category_not_found');
      const res = await walletRepository.incBalance(
        body.wallet,
        userId,
        delta(body.kind, body.amount),
        session,
      );
      if (res.matchedCount === 0) throw new NotFoundError('wallet_not_found');
      return transactionRepository.create(userId, body, session);
    });
  },

  // Reverses the old balance effect and applies the new one atomically.
  update(userId: string, id: string, body: Partial<TxBody>) {
    return withMaybeTransaction(async (session) => {
      const old = await transactionRepository.findForUser(id, userId, session);
      if (!old) throw new NotFoundError();

      const nextWallet = body.wallet ?? old.wallet;
      const nextKind = body.kind ?? old.kind;
      const nextAmount = body.amount ?? old.amount;

      const [categoryExists, walletOwned] = await Promise.all([
        body.cat ? categoryRepository.existsForUser(body.cat, userId) : Promise.resolve(true),
        walletRepository.existsForUser(String(nextWallet), userId, session),
      ]);
      if (body.cat && !categoryExists) throw new NotFoundError('category_not_found');
      // The target wallet must be owned before any balance is mutated.
      if (!walletOwned) throw new NotFoundError('wallet_not_found');

      // Reverse the old effect (no-op if its wallet was since deleted), then
      // apply the new effect on the verified wallet.
      await walletRepository.incBalance(
        String(old.wallet),
        userId,
        -delta(old.kind, old.amount),
        session,
      );
      await walletRepository.incBalance(String(nextWallet), userId, delta(nextKind, nextAmount), session);

      return transactionRepository.updateForUser(id, userId, body, session);
    });
  },

  remove(userId: string, id: string) {
    return withMaybeTransaction(async (session) => {
      const tx = await transactionRepository.findForUser(id, userId, session);
      if (!tx) throw new NotFoundError();
      await walletRepository.incBalance(
        String(tx.wallet),
        userId,
        -delta(tx.kind, tx.amount),
        session,
      );
      await transactionRepository.deleteForUser(id, userId, session);
    });
  },

  async statsForMonth(userId: string, month: string) {
    const { income, expense, count } = await transactionRepository.statsForMonth(
      userId,
      monthRange(month),
    );
    return { income, expense, net: income - expense, count };
  },
};
