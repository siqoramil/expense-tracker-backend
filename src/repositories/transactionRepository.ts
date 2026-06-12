import { type ClientSession, Types } from 'mongoose';
import { Transaction } from '../models/Transaction.js';

type TxInput = {
  kind: 'income' | 'expense';
  cat: string;
  wallet: string;
  amount: number;
  note?: string;
  date: string;
};

// Data access for transactions. The atomic wallet-balance coupling lives in
// transactionService (which composes this with walletRepository inside a
// withMaybeTransaction session); this layer is pure persistence.
export const transactionRepository = {
  list(userId: string, opts: { range?: { gte: string; lt: string }; kind?: 'income' | 'expense'; limit: number }) {
    const filter: Record<string, unknown> = { userId };
    if (opts.range) filter.date = { $gte: opts.range.gte, $lt: opts.range.lt };
    if (opts.kind) filter.kind = opts.kind;
    return Transaction.find(filter).sort({ date: -1, createdAt: -1 }).limit(opts.limit).lean();
  },

  findForUser(id: string, userId: string, session?: ClientSession | null) {
    return Transaction.findOne({ _id: id, userId }, null, { session }).lean();
  },

  create(userId: string, data: TxInput, session?: ClientSession | null) {
    return Transaction.create([{ ...data, userId }], { session: session ?? undefined }).then(
      ([doc]) => doc,
    );
  },

  updateForUser(id: string, userId: string, patch: Partial<TxInput>, session?: ClientSession | null) {
    return Transaction.findOneAndUpdate(
      { _id: id, userId },
      { $set: patch },
      { new: true, lean: true, session: session ?? undefined },
    );
  },

  deleteForUser(id: string, userId: string, session?: ClientSession | null) {
    return Transaction.deleteOne({ _id: id, userId }, { session: session ?? undefined });
  },

  countByWallet(walletId: string, userId: string) {
    return Transaction.countDocuments({ wallet: walletId, userId });
  },

  countByCat(catId: string, userId: string) {
    return Transaction.countDocuments({ cat: catId, userId });
  },

  async statsForMonth(userId: string, range: { gte: string; lt: string }) {
    const grouped = await Transaction.aggregate<{ _id: 'income' | 'expense'; sum: number; count: number }>([
      { $match: { userId: new Types.ObjectId(userId), date: { $gte: range.gte, $lt: range.lt } } },
      { $project: { _id: 0, kind: 1, amount: 1 } },
      { $group: { _id: '$kind', sum: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    let income = 0;
    let expense = 0;
    let count = 0;
    for (const row of grouped) {
      count += row.count;
      if (row._id === 'income') income = row.sum;
      else if (row._id === 'expense') expense = row.sum;
    }
    return { income, expense, count };
  },

  deleteByUser(userId: string, session?: ClientSession | null) {
    return Transaction.deleteMany({ userId }, session ? { session } : {});
  },
};
