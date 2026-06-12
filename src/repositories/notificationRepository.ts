import type { ClientSession } from 'mongoose';
import { Notification } from '@/models';

// Data access for notifications. Every query is scoped by userId so a user can
// only ever touch their own documents (IDOR protection lives here, not in routes).
export const notificationRepository = {
  list(userId: string, limit: number, skip: number) {
    return Notification.find({ userId }).sort({ date: -1 }).skip(skip).limit(limit).lean();
  },

  markRead(id: string, userId: string) {
    return Notification.findOneAndUpdate(
      { _id: id, userId },
      { $set: { read: true } },
      { new: true, lean: true },
    );
  },

  markAllRead(userId: string) {
    return Notification.updateMany({ userId, read: false }, { $set: { read: true } });
  },

  deleteForUser(id: string, userId: string) {
    return Notification.deleteOne({ _id: id, userId });
  },

  deleteByUser(userId: string, session?: ClientSession | null) {
    return Notification.deleteMany({ userId }, session ? { session } : {});
  },
};
