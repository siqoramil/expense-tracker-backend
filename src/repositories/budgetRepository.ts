import type { ClientSession } from 'mongoose';
import { Budget } from '../models/Budget.js';

// Data access for budgets. Every query is scoped by userId so a user can only
// ever touch their own documents (IDOR protection lives here, not in routes).
export const budgetRepository = {
  listByUser(userId: string) {
    return Budget.find({ userId }).sort({ createdAt: 1 }).lean();
  },

  create(userId: string, data: { cat: string; limit: number }) {
    return Budget.create({ ...data, userId });
  },

  updateForUser(id: string, userId: string, patch: { limit?: number }) {
    // $set so a body key like "$unset" can never be interpreted as a Mongo
    // update operator (defence-in-depth alongside the strict route schema).
    return Budget.findOneAndUpdate({ _id: id, userId }, { $set: patch }, { new: true, lean: true });
  },

  countByCat(catId: string, userId: string) {
    return Budget.countDocuments({ cat: catId, userId });
  },

  deleteForUser(id: string, userId: string) {
    return Budget.deleteOne({ _id: id, userId });
  },

  deleteByUser(userId: string, session?: ClientSession | null) {
    return Budget.deleteMany({ userId }, session ? { session } : {});
  },
};
