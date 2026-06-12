import type { ClientSession } from 'mongoose';
import { Debt } from '../models/Debt.js';

type PaymentInput = { amount: number; date: string };

// Data access for debts. Every query is scoped by userId so a user can only
// ever touch their own documents (IDOR protection lives here, not in routes).
export const debtRepository = {
  listByUser(userId: string, includeArchived: boolean) {
    const filter: Record<string, unknown> = { userId };
    if (!includeArchived) filter.archived = { $ne: true };
    return Debt.find(filter).sort({ createdAt: -1 }).limit(1000).lean();
  },

  countByUser(userId: string) {
    return Debt.countDocuments({ userId });
  },

  create(
    userId: string,
    data: {
      direction: 'owe_me' | 'i_owe';
      name: string;
      color?: string;
      amount: number;
      due: string;
      note?: string;
    },
  ) {
    return Debt.create({ ...data, userId, paid: 0, payments: [] });
  },

  findForUser(id: string, userId: string) {
    return Debt.findOne({ _id: id, userId });
  },

  updateForUser(id: string, userId: string, patch: Record<string, unknown>) {
    // $set so a body key like "$unset" can never be interpreted as a Mongo
    // update operator (defence-in-depth alongside the strict route schema).
    return Debt.findOneAndUpdate({ _id: id, userId }, { $set: patch }, { new: true, lean: true });
  },

  deleteForUser(id: string, userId: string) {
    return Debt.deleteOne({ _id: id, userId });
  },

  archive(id: string, userId: string) {
    return Debt.findOneAndUpdate(
      { _id: id, userId },
      [{ $set: { archived: true, paid: '$amount' } }],
      { new: true, lean: true },
    );
  },

  addPayment(id: string, userId: string, payment: PaymentInput, paidIncrement: number) {
    return Debt.findOneAndUpdate(
      { _id: id, userId },
      { $push: { payments: payment }, $inc: { paid: paidIncrement } },
      { new: true, lean: true },
    );
  },

  deleteByUser(userId: string, session?: ClientSession | null) {
    return Debt.deleteMany({ userId }, session ? { session } : {});
  },
};
