import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  isDuplicateKeyError,
} from '@/core';
import { generateCode, normalizeEmail, sendVerificationCode } from '@/lib';
import type { User } from '@/models';
import { userRepository, verificationCodeRepository } from '@/repositories';
import { CODE_RESEND_COOLDOWN_MS, CODE_TTL_MS, CODE_TTL_SECONDS } from './constants.js';
import { requireReauth, verifyAuthCode } from './helpers.js';

// Generates and emails a code for email change. Returns { sent, expiresInSeconds }.
// Silent no-op (returns same shape without sending) when newEmail is already
// registered, to prevent enumerating other users' addresses.
export const requestEmailChange = async (
  userId: string,
  newEmailRaw: string,
): Promise<{ sent: true; expiresInSeconds: number }> => {
  const newEmail = normalizeEmail(newEmailRaw);
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError();
  if (user.email === newEmail) throw new BadRequestError('same_email');

  // Cooldown checked before the taken-email branch so timing/shape is the
  // same whether or not the target address is registered.
  const onCooldown = await verificationCodeRepository.findRecent(
    user._id,
    'email_change',
    CODE_RESEND_COOLDOWN_MS,
  );
  if (onCooldown) throw new TooManyRequestsError('code_recently_sent');

  // Treat already-registered targets as a silent no-op. Returning { sent: true }
  // either way denies an authenticated caller an oracle for enumerating other
  // users' email addresses. The legit user discovers the conflict when
  // verify-change rejects the code they never receive.
  const taken = await userRepository.findByEmail(newEmail);
  if (!taken) {
    await verificationCodeRepository.deleteUnconsumed(user._id, 'email_change');
    const code = generateCode();
    await verificationCodeRepository.create({
      email: user.email,
      newEmail,
      code,
      purpose: 'email_change',
      userId: user._id,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    try {
      await sendVerificationCode(newEmail, code, 'email change');
    } catch {
      throw new ServiceUnavailableError('mail_send_failed');
    }
  }

  return { sent: true, expiresInSeconds: CODE_TTL_SECONDS };
};

// Re-authenticates, verifies the code, and applies the email change.
// Bumps passwordChangedAt to revoke all prior JWTs (email change is
// credential-equivalent). Returns the updated user document.
export const verifyEmailChange = async (
  userId: string,
  body: { code: string; password?: string; idToken?: string },
): Promise<InstanceType<typeof User>> => {
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError();

  await requireReauth(user, body);

  const record = await verifyAuthCode(user, 'email_change', body.code);

  if (!record.newEmail) throw new BadRequestError('invalid_state');

  const stillTaken = await userRepository.findByEmail(record.newEmail);
  if (stillTaken && stillTaken.id !== user.id) {
    throw new ConflictError('email_taken');
  }

  user.email = record.newEmail;
  // Email change is a credential-equivalent event: revoke prior JWTs.
  user.passwordChangedAt = new Date();
  try {
    await userRepository.save(user);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ConflictError('email_taken');
    throw err;
  }
  await verificationCodeRepository.consume(record._id);

  return user;
};
