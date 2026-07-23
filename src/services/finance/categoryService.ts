import { ConflictError, NotFoundError } from '@/core';
import {
  budgetRepository,
  categoryRepository,
  recurringRepository,
  transactionRepository,
} from '@/repositories';
import { seedDefaultCategories } from '@/lib';

type CategoryCreate = {
  label: { en: string; uz: string };
  icon: string;
  color: string;
  kind: 'income' | 'expense';
};

type CategoryPatch = Partial<CategoryCreate>;

// Per-user document cap (abuse / storage-exhaustion guard).
const MAX_CATEGORIES = 300;

// Business logic for categories. Throws typed AppErrors (mapped to HTTP by the
// global error handler) so routes stay thin and transport-agnostic.
export const categoryService = {
  async list(userId: string) {
    const count = await categoryRepository.countByUser(userId);
    if (count === 0) {
      // Backfill accounts created before server-side category seeding. Best-effort:
      // a seed failure must not block the list from returning.
      await seedDefaultCategories(userId).catch(() => {});
    }
    return categoryRepository.listByUser(userId);
  },

  async create(userId: string, data: CategoryCreate) {
    const count = await categoryRepository.countByUser(userId);
    if (count >= MAX_CATEGORIES) throw new ConflictError('limit_reached');
    return categoryRepository.create(userId, data);
  },

  async update(userId: string, id: string, patch: CategoryPatch) {
    const cat = await categoryRepository.updateForUser(id, userId, patch);
    if (!cat) throw new NotFoundError();
    return cat;
  },

  async remove(userId: string, id: string) {
    const [txCount, budgetCount, recurringCount] = await Promise.all([
      transactionRepository.countByCat(id, userId),
      budgetRepository.countByCat(id, userId),
      recurringRepository.countByCat(id, userId),
    ]);
    if (txCount > 0 || budgetCount > 0 || recurringCount > 0) {
      throw new ConflictError('category_in_use');
    }
    const res = await categoryRepository.deleteForUser(id, userId);
    if (res.deletedCount === 0) throw new NotFoundError();
  },
};
