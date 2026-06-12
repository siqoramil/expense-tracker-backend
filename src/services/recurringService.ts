import { ConflictError, NotFoundError } from '../core/errors.js';
import { categoryRepository } from '../repositories/categoryRepository.js';
import { recurringRepository } from '../repositories/recurringRepository.js';
import { walletRepository } from '../repositories/walletRepository.js';

type RecurringInput = {
  kind: 'income' | 'expense';
  cat: string;
  wallet: string;
  amount: number;
  note?: string;
  every?: 'month' | 'week';
  nextDate: string;
  enabled?: boolean;
};

const MAX_RECURRING = 200;

// Validates that a referenced category / wallet (when present in the payload)
// is owned by the user; throws the matching not-found error otherwise.
const assertRefsOwned = async (
  userId: string,
  refs: { cat?: string; wallet?: string },
): Promise<void> => {
  if (refs.cat !== undefined && !(await categoryRepository.existsForUser(refs.cat, userId))) {
    throw new NotFoundError('category_not_found');
  }
  if (refs.wallet !== undefined && !(await walletRepository.existsForUser(refs.wallet, userId))) {
    throw new NotFoundError('wallet_not_found');
  }
};

export const recurringService = {
  list(userId: string) {
    return recurringRepository.listByUser(userId);
  },

  async create(userId: string, data: RecurringInput) {
    const count = await recurringRepository.countByUser(userId);
    if (count >= MAX_RECURRING) throw new ConflictError('limit_reached');
    await assertRefsOwned(userId, { cat: data.cat, wallet: data.wallet });
    return recurringRepository.create(userId, data);
  },

  async update(userId: string, id: string, patch: Partial<RecurringInput>) {
    await assertRefsOwned(userId, { cat: patch.cat, wallet: patch.wallet });
    const item = await recurringRepository.updateForUser(id, userId, patch);
    if (!item) throw new NotFoundError();
    return item;
  },

  async remove(userId: string, id: string) {
    const res = await recurringRepository.deleteForUser(id, userId);
    if (res.deletedCount === 0) throw new NotFoundError();
  },
};
