import { Category } from '../models/Category.js';

// Data access for categories. Other domains (budgets, transactions, recurring)
// depend on `existsForUser` to validate ownership of a referenced category.
export const categoryRepository = {
  existsForUser(id: string, userId: string) {
    return Category.exists({ _id: id, userId });
  },
};
