import { NotFoundError } from '@/core';
import { notificationRepository } from '@/repositories';

// Business logic for notifications. Throws typed AppErrors (mapped to HTTP by
// the global error handler) so routes stay thin and transport-agnostic.
export const notificationService = {
  list(userId: string, limit: number, skip: number) {
    return notificationRepository.list(userId, limit, skip);
  },

  async markRead(userId: string, id: string) {
    const item = await notificationRepository.markRead(id, userId);
    if (!item) throw new NotFoundError();
    return item;
  },

  async markAllRead(userId: string) {
    await notificationRepository.markAllRead(userId);
  },

  async remove(userId: string, id: string) {
    const res = await notificationRepository.deleteForUser(id, userId);
    if (res.deletedCount === 0) throw new NotFoundError();
  },
};
