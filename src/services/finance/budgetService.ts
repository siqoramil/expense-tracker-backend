import { ConflictError, NotFoundError, isDuplicateKeyError } from '@/core';
import { budgetRepository, categoryRepository } from '@/repositories';

// Business logic for budgets. Throws typed AppErrors (mapped to HTTP by the
// global error handler) so routes stay thin and transport-agnostic.
export const budgetService = {
  list(userId: string) {
    return budgetRepository.listByUser(userId);
  },

  async create(userId: string, data: { cat: string; limit: number }) {
    const categoryExists = await categoryRepository.existsForUser(data.cat, userId);
    if (!categoryExists) throw new NotFoundError('category_not_found');
    try {
      return await budgetRepository.create(userId, data);
    } catch (err) {
      // One budget per (user, category): the unique index rejects duplicates.
      if (isDuplicateKeyError(err)) throw new ConflictError('budget_exists');
      throw err;
    }
  },

  async update(userId: string, id: string, patch: { limit?: number }) {
    const budget = await budgetRepository.updateForUser(id, userId, patch);
    if (!budget) throw new NotFoundError();
    return budget;
  },

  async remove(userId: string, id: string) {
    const res = await budgetRepository.deleteForUser(id, userId);
    if (res.deletedCount === 0) throw new NotFoundError();
  },
};
