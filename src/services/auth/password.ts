import bcrypt from 'bcryptjs';
import { BadRequestError, TooManyRequestsError } from '@/core';
import { generateCode, normalizeEmail, sendVerificationCode } from '@/lib';
import type { User } from '@/models';
import { userRepository, verificationCodeRepository } from '@/repositories';
import {
  BCRYPT_ROUNDS,
  CODE_RESEND_COOLDOWN_MS,
  CODE_TTL_MS,
  CODE_TTL_SECONDS,
} from './constants.js';
import { verifyAuthCode } from './helpers.js';

// Generates and emails a password reset code. Always returns
// { sent, expiresInSeconds } regardless of whether the email is registered
// (never leaks account existence). SMTP is fire-and-forget.
export const forgotPassword = async (
  emailRaw: string,
): Promise<{ sent: true; expiresInSeconds: number }> => {
  const email = normalizeEmail(emailRaw);
  const user = await userRepository.findByEmail(email);

  if (user) {
    // Cooldown: if a code was issued for this account in the last minute, do
    // NOT send another (anti mail-bombing). Response stays identical.
    const onCooldown = await verificationCodeRepository.findRecent(
      user._id,
      'password_reset',
      CODE_RESEND_COOLDOWN_MS,
    );
    if (!onCooldown) {
      await verificationCodeRepository.deleteUnconsumed(user._id, 'password_reset');
      const code = generateCode();
      await verificationCodeRepository.create({
        email,
        code,
        purpose: 'password_reset',
        userId: user._id,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      // Fire-and-forget: SMTP latency (~200-500 ms) would dwarf every other
      // timing component and reveal account existence if awaited. Errors are
      // swallowed for the same reason.
      void sendVerificationCode(email, code, 'password reset').catch(() => {});
    }
  } else {
    // Match the wall-clock shape of the user-exists branch so attackers
    // cannot distinguish "no account" from "account but SMTP queued in
    // background" by measuring response time. These two reads cost roughly
    // the same as deleteMany + create without writing dummy rows.
    await verificationCodeRepository.timingProbe(email);
  }

  return { sent: true, expiresInSeconds: CODE_TTL_SECONDS };
};

// Verifies a password reset code. Returns the email (normalised) and the
// live user document. The route uses the email to mint the verifiedToken.
// Does NOT consume the code (that happens in resetPassword).
export const verifyResetCode = async (
  emailRaw: string,
  submittedCode: string,
): Promise<{ user: InstanceType<typeof User>; email: string }> => {
  const email = normalizeEmail(emailRaw);
  const user = await userRepository.findByEmail(email);
  if (!user) throw new BadRequestError('invalid_code');

  // Per-account lockout survives /password/forgot re-issuance.
  if (user.resetLockedUntil && user.resetLockedUntil.getTime() > Date.now()) {
    throw new TooManyRequestsError('too_many_attempts');
  }

  await verifyAuthCode(user, 'password_reset', submittedCode);

  return { user, email };
};

// Applies the new password after verifying the code and verifiedToken (which
// the route validates before calling this). Consumes the code, revokes prior
// JWTs via passwordChangedAt, and clears the reset lockout. Returns the user.
export const resetPassword = async (
  emailRaw: string,
  submittedCode: string,
  newPassword: string,
): Promise<InstanceType<typeof User>> => {
  const email = normalizeEmail(emailRaw);
  const user = await userRepository.findByEmail(email);
  if (!user) throw new BadRequestError('invalid_code');

  // Per-account lockout survives /password/forgot re-issuance.
  if (user.resetLockedUntil && user.resetLockedUntil.getTime() > Date.now()) {
    throw new TooManyRequestsError('too_many_attempts');
  }

  const record = await verifyAuthCode(user, 'password_reset', submittedCode);

  user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  // Bumping passwordChangedAt revokes every JWT issued before this moment.
  user.passwordChangedAt = new Date();
  // Successful reset clears the per-account brute-force lockout.
  user.resetFailedAttempts = 0;
  user.resetLockedUntil = null;
  await Promise.all([userRepository.save(user), verificationCodeRepository.consume(record._id)]);

  return user;
};
