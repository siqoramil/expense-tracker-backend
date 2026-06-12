import type { ClientSession } from 'mongoose';
import { VerificationCode } from '@/models';

type Purpose = 'password_reset' | 'email_change' | 'account_delete';

// Data access for verification codes. All business logic (TTLs, MAX_ATTEMPTS,
// cooldowns) lives in authService; this layer only wraps Mongoose operations.
export const verificationCodeRepository = {
  create(data: {
    email: string;
    code: string;
    purpose: Purpose;
    userId?: unknown;
    newEmail?: string;
    expiresAt: Date;
  }) {
    return VerificationCode.create(data);
  },

  // Returns the most recent unconsumed, unexpired code for this user+purpose.
  findLatestValid(userId: unknown, purpose: Purpose) {
    return VerificationCode.findOne({
      userId,
      purpose,
      consumed: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
  },

  // Cooldown check: returns the record (lean) if a fresh code was issued for
  // this user+purpose within sinceMs milliseconds. Preserves the exact query
  // from the original codeOnCooldown helper.
  findRecent(userId: unknown, purpose: Purpose, sinceMs: number) {
    return VerificationCode.findOne({
      userId,
      purpose,
      consumed: false,
      expiresAt: { $gt: new Date() },
      createdAt: { $gt: new Date(Date.now() - sinceMs) },
    })
      .select({ _id: 1 })
      .lean();
  },

  incrementAttempts(id: unknown) {
    return VerificationCode.updateOne({ _id: id }, { $inc: { attempts: 1 } });
  },

  // Marks the code as consumed via an atomic updateOne instead of a doc
  // mutation + save, so no stale document reference is needed by callers.
  consume(id: unknown) {
    return VerificationCode.updateOne({ _id: id }, { $set: { consumed: true } });
  },

  deleteUnconsumed(userId: unknown, purpose: Purpose) {
    return VerificationCode.deleteMany({ userId, purpose, consumed: false });
  },

  // Timing-equalisation probe for the /password/forgot no-account branch.
  // Runs the same two reads as the account-exists branch (deleteMany + create)
  // so the response time does not reveal whether the email is registered.
  // The queries are intentional no-ops and must stay as-is.
  async timingProbe(email: string) {
    await VerificationCode.findOne({
      userId: null,
      purpose: 'password_reset',
      email,
    }).lean();
    await VerificationCode.countDocuments({
      purpose: 'password_reset',
      email,
    });
  },

  deleteByUser(userId: unknown, session?: ClientSession | null) {
    return VerificationCode.deleteMany({ userId }, session ? { session } : {});
  },
};
