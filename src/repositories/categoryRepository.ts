import type { ClientSession } from 'mongoose';
import { Category } from '../models/Category.js';

type CategoryInput = {
  label: { en: string; uz: string };
  icon: string;
  color: string;
  kind: 'income' | 'expense';
};

// Data access for categories. Other domains (budgets, transactions, recurring)
// depend on `existsForUser` to validate ownership of a referenced category.
// All queries are scoped by userId so IDOR protection lives here, not in routes.
export const categoryRepository = {
  existsForUser(id: string, userId: string) {
    return Category.exists({ _id: id, userId });
  },

  listByUser(userId: string) {
    return Category.find({ userId }).sort({ createdAt: 1 }).lean();
  },

  countByUser(userId: string) {
    return Category.countDocuments({ userId });
  },

  create(userId: string, data: CategoryInput) {
    return Category.create({ ...data, userId });
  },

  updateForUser(id: string, userId: string, patch: Partial<CategoryInput>) {
    // $set so a body key like "$unset" can never be interpreted as a Mongo
    // update operator (defence-in-depth alongside the strict route schema).
    return Category.findOneAndUpdate({ _id: id, userId }, { $set: patch }, { new: true, lean: true });
  },

  deleteForUser(id: string, userId: string) {
    return Category.deleteOne({ _id: id, userId });
  },

  deleteByUser(userId: string, session?: ClientSession | null) {
    return Category.deleteMany({ userId }, session ? { session } : {});
  },
};
