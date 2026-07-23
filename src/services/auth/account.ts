import { NotFoundError } from '@/core';
import { withMaybeTransaction } from '@/lib';
import {
  budgetRepository,
  categoryRepository,
  debtRepository,
  notificationRepository,
  recurringRepository,
  transactionRepository,
  userRepository,
  verificationCodeRepository,
  walletRepository,
} from '@/repositories';
import { issueAuthCode, requireReauth, verifyAuthCode } from './helpers.js';

// Generates and emails a code for account deletion. Returns { sent, expiresInSeconds }.
export const requestDelete = async (
  userId: string,
): Promise<{ sent: true; expiresInSeconds: number }> => {
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError();
  return issueAuthCode(user, 'account_delete');
};

// Re-authenticates, verifies the code, then deletes all user data atomically.
export const confirmDelete = async (
  userId: string,
  body: { code: string; password?: string; idToken?: string },
): Promise<void> => {
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError();

  await requireReauth(user, body);

  await verifyAuthCode(user, 'account_delete', body.code);

  // Wrap the cascade in a transaction (on replica sets) so a mid-cascade
  // failure rolls back instead of leaving orphan documents attached to a
  // deleted user. On standalone Mongo the helper falls back to non-atomic
  // writes (documented dev-only caveat).
  const uid = user._id;
  await withMaybeTransaction(async (session) => {
    await Promise.all([
      transactionRepository.deleteByUser(String(uid), session),
      budgetRepository.deleteByUser(String(uid), session),
      categoryRepository.deleteByUser(String(uid), session),
      debtRepository.deleteByUser(String(uid), session),
      notificationRepository.deleteByUser(String(uid), session),
      recurringRepository.deleteByUser(String(uid), session),
      walletRepository.deleteByUser(String(uid), session),
      verificationCodeRepository.deleteByUser(uid, session),
    ]);
    await userRepository.deleteById(uid, session);
  });
};
