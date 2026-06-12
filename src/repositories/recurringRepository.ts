import type { ClientSession } from 'mongoose';
import { Recurring } from '../models/Recurring.js';

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

export const recurringRepository = {
  listByUser(userId: string) {
    return Recurring.find({ userId }).sort({ nextDate: 1 }).limit(1000).lean();
  },

  countByUser(userId: string) {
    return Recurring.countDocuments({ userId });
  },

  countByCat(catId: string, userId: string) {
    return Recurring.countDocuments({ cat: catId, userId });
  },

  create(userId: string, data: RecurringInput) {
    return Recurring.create({ ...data, userId });
  },

  updateForUser(id: string, userId: string, patch: Partial<RecurringInput>) {
    return Recurring.findOneAndUpdate({ _id: id, userId }, { $set: patch }, { new: true, lean: true });
  },

  deleteForUser(id: string, userId: string) {
    return Recurring.deleteOne({ _id: id, userId });
  },

  deleteByUser(userId: string, session?: ClientSession | null) {
    return Recurring.deleteMany({ userId }, session ? { session } : {});
  },
};
