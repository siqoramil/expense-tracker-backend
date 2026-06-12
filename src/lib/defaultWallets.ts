import type { Types } from 'mongoose';
import { Wallet } from '@/models';

interface DefaultWallet {
  name: { en: string; uz: string };
  icon: string;
  color: string;
}

// Default wallets every new account starts with. Seeded SERVER-side (like
// default categories) so every device that logs into the account sees the
// same wallets instead of each device seeding its own local copy and drifting.
export const DEFAULT_WALLETS: DefaultWallet[] = [
  { name: { en: 'Cash', uz: 'Naqd' }, icon: 'wallet', color: '#10B981' },
  { name: { en: 'Card', uz: 'Karta' }, icon: 'credit-card', color: '#6366F1' },
];

// Inserts any default wallets that are missing for the given user. Matching is
// done by name.en (the same key the mobile bootstrap uses for dedup), so
// existing wallets are linked rather than duplicated. Safe to call repeatedly.
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
