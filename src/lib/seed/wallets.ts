import type { Types } from 'mongoose';
import { Wallet } from '@/models';

interface DefaultWallet {
  name: { en: string; uz: string };
  icon: string;
  color: string;
}

export const DEFAULT_WALLETS: DefaultWallet[] = [
  { name: { en: 'Cash', uz: 'Naqd' }, icon: 'wallet', color: '#10B981' },
  { name: { en: 'Card', uz: 'Karta' }, icon: 'credit-card', color: '#6366F1' },
];

export async function seedDefaultWallets(userId: Types.ObjectId | string): Promise<void> {
  const existing = await Wallet.find({ userId }, { 'name.en': 1, _id: 0 }).lean();

  const existingNames = new Set(existing.filter((w) => w.name != null).map((w) => w.name!.en));

  const toInsert = DEFAULT_WALLETS.filter((d) => !existingNames.has(d.name.en)).map((d) => ({
    ...d,
    userId,
    balance: 0,
  }));

  if (toInsert.length > 0) {
    await Wallet.insertMany(toInsert, { ordered: false });
  }
}
