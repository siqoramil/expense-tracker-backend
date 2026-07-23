import { ConflictError, NotFoundError } from '@/core';
import { seedDefaultWallets } from '@/lib';
import { transactionRepository, walletRepository } from '@/repositories';

type WalletCreate = {
  name: { en: string; uz: string };
  icon: string;
  color: string;
  balance?: number;
};
type WalletPatch = { name?: { en: string; uz: string }; icon?: string; color?: string };

// Per-user document cap (abuse / storage-exhaustion guard).
const MAX_WALLETS = 100;

export const walletService = {
  async list(userId: string) {
    const wallets = await walletRepository.listByUser(userId);
    if (wallets.length > 0) return wallets;
    // Backfill accounts created before server-side wallet seeding. Best-effort:
    // a seed failure must not block the list.
    await seedDefaultWallets(userId).catch(() => {});
    return walletRepository.listByUser(userId);
  },

  async create(userId: string, data: WalletCreate) {
    const count = await walletRepository.countByUser(userId);
    if (count >= MAX_WALLETS) throw new ConflictError('limit_reached');
    return walletRepository.create(userId, data);
  },

  async update(userId: string, id: string, patch: WalletPatch) {
    const wallet = await walletRepository.updateForUser(id, userId, patch);
    if (!wallet) throw new NotFoundError();
    return wallet;
  },

  async remove(userId: string, id: string) {
    // Block deletion while any transaction still references the wallet, to
    // avoid orphaned transactions.
    const txCount = await transactionRepository.countByWallet(id, userId);
    if (txCount > 0) throw new ConflictError('wallet_not_empty');
    const res = await walletRepository.deleteForUser(id, userId);
    if (res.deletedCount === 0) throw new NotFoundError();
  },
};
