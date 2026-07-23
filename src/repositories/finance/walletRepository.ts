import type { ClientSession } from 'mongoose';
import { Wallet } from '@/models';

type WalletInput = {
  name: { en: string; uz: string };
  icon: string;
  color: string;
  balance?: number;
};

// Data access for wallets. Cross-domain consumers (transactions, recurring)
// use existsForUser/incBalance; everything is scoped by userId.
export const walletRepository = {
  listByUser(userId: string) {
    return Wallet.find({ userId }).sort({ createdAt: 1 }).lean();
  },

  countByUser(userId: string) {
    return Wallet.countDocuments({ userId });
  },

  existsForUser(id: string, userId: string, session?: ClientSession | null) {
    return Wallet.findOne({ _id: id, userId }, { _id: 1 }, { session: session ?? undefined });
  },

  create(userId: string, data: WalletInput) {
    return Wallet.create({ ...data, userId });
  },

  updateForUser(id: string, userId: string, patch: Partial<WalletInput>) {
    return Wallet.findOneAndUpdate({ _id: id, userId }, { $set: patch }, { new: true, lean: true });
  },

  deleteForUser(id: string, userId: string) {
    return Wallet.deleteOne({ _id: id, userId });
  },

  // Atomically adjust a wallet balance. Returns the driver result so callers
  // can check matchedCount (0 = wallet not owned). Runs inside the optional
  // transaction session passed by the transaction service.
  incBalance(id: string, userId: string, delta: number, session?: ClientSession | null) {
    return Wallet.updateOne(
      { _id: id, userId },
      { $inc: { balance: delta } },
      { session: session ?? undefined },
    );
  },

  deleteByUser(userId: string, session?: ClientSession | null) {
    return Wallet.deleteMany({ userId }, session ? { session } : {});
  },
};
