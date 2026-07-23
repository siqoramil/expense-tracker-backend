import bcrypt from 'bcryptjs';
import {
  BadRequestError,
  LockedError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
} from '@/core';
import { generateCode, safeCodeEqual, sendVerificationCode } from '@/lib';
import type { User, VerificationCode } from '@/models';
import { userRepository, verificationCodeRepository } from '@/repositories';
import {
  CODE_RESEND_COOLDOWN_MS,
  CODE_TTL_MS,
  CODE_TTL_SECONDS,
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_LOCKOUT_MS,
  MAX_ATTEMPTS,
  RESET_LOCKOUT_MS,
  RESET_LOCKOUT_THRESHOLD,
} from './constants.js';
import { googleAudiences, googleClient, verifyGoogleIdToken } from './google.js';

export const initialsFrom = (name: string) =>
  name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

// Checks lockout, compares password, and updates failure/lockout counters
// on the live document. Returns 'locked' | 'invalid' | 'ok'. Callers must
// save() the user after 'ok' or 'invalid' (the doc is mutated in-place).
export const checkPasswordAuth = async (
  user: InstanceType<typeof User>,
  password: string,
): Promise<'locked' | 'invalid' | 'ok'> => {
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    // Equalize timing: run the same bcrypt work the non-locked path does so
    // a locked account is not measurably faster to probe (timing oracle).
    await bcrypt.compare(password, user.passwordHash);
    return 'locked';
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    user.failedLogins = (user.failedLogins ?? 0) + 1;
    if (user.failedLogins >= LOGIN_FAILURE_THRESHOLD) {
      user.lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_MS);
      user.failedLogins = 0;
    }
    return 'invalid';
  }
  if (user.failedLogins || user.lockedUntil) {
    user.failedLogins = 0;
    user.lockedUntil = null;
  }
  return 'ok';
};

// Re-authentication gate shared by confirm-delete and verify-change. Both
// flows require the caller to prove current credential ownership on top of
// having a valid JWT, so a stolen token alone cannot complete the action.
//
// For password accounts: verifies the supplied password and mutates the doc's
//   lockout fields. Callers must save() the doc before proceeding.
// For Google-only accounts: verifies the idToken and checks sub matches.
//
// Throws the appropriate AppError on failure so the route stays thin.
export const requireReauth = async (
  user: InstanceType<typeof User>,
  body: { password?: string; idToken?: string },
): Promise<void> => {
  if (user.passwordHash) {
    if (!body.password) {
      throw new BadRequestError('password_required');
    }
    const authResult = await checkPasswordAuth(user, body.password);
    await userRepository.save(user);
    if (authResult === 'locked') throw new LockedError('account_locked');
    if (authResult === 'invalid') throw new UnauthorizedError('invalid_credentials');
  } else {
    // Google-only account: require a fresh ID token whose sub matches the
    // linked googleId. The ID token is signed by Google and short-lived, so
    // possession proves current control of the Google login.
    if (!googleClient || googleAudiences.length === 0) {
      throw new ServiceUnavailableError('google_auth_disabled');
    }
    if (!body.idToken) {
      throw new BadRequestError('id_token_required');
    }
    const payload = await verifyGoogleIdToken(body.idToken);
    if (!payload.sub || payload.sub !== user.googleId) {
      throw new UnauthorizedError('invalid_google_token');
    }
  }
};

// Issues a fresh verification code for a given purpose (account_delete or
// email_change). Enforces the per-account cooldown and de-duplicates any
// prior unconsumed codes. Returns { expiresInSeconds }.
//
// For email_change the code is sent to newEmail (the target address) and the
// newEmail field is stored on the record. For account_delete it goes to
// user.email and newEmail is not stored.
//
// Throws TooManyRequestsError('code_recently_sent') if on cooldown.
// Throws ServiceUnavailableError('mail_send_failed') if SMTP fails.
export const issueAuthCode = async (
  user: InstanceType<typeof User>,
  purpose: 'account_delete' | 'email_change',
  opts?: { newEmail?: string },
): Promise<{ sent: true; expiresInSeconds: number }> => {
  const onCooldown = await verificationCodeRepository.findRecent(
    user._id,
    purpose,
    CODE_RESEND_COOLDOWN_MS,
  );
  if (onCooldown) {
    throw new TooManyRequestsError('code_recently_sent');
  }

  await verificationCodeRepository.deleteUnconsumed(user._id, purpose);

  const code = generateCode();
  await verificationCodeRepository.create({
    email: user.email,
    code,
    purpose,
    userId: user._id,
    newEmail: opts?.newEmail,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  const sendTo = opts?.newEmail ?? user.email;
  const reason = purpose === 'account_delete' ? 'account deletion' : 'email change';
  try {
    await sendVerificationCode(sendTo, code, reason);
  } catch {
    throw new ServiceUnavailableError('mail_send_failed');
  }

  return { sent: true as const, expiresInSeconds: CODE_TTL_SECONDS };
};

// Verifies the supplied code against the latest valid record for this user +
// purpose. Enforces MAX_ATTEMPTS and the per-account reset lockout (for
// password_reset only). Returns the matching record on success.
//
// Throws:
//   BadRequestError('code_expired')         - no valid record
//   TooManyRequestsError('too_many_attempts') - record attempts exhausted
//   BadRequestError('invalid_code')          - wrong code
export const verifyAuthCode = async (
  user: InstanceType<typeof User>,
  purpose: 'account_delete' | 'email_change' | 'password_reset',
  submittedCode: string,
): Promise<InstanceType<typeof VerificationCode>> => {
  const record = await verificationCodeRepository.findLatestValid(user._id, purpose);

  if (!record) {
    throw new BadRequestError('code_expired');
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    throw new TooManyRequestsError('too_many_attempts');
  }
  if (!safeCodeEqual(record.code, submittedCode)) {
    await verificationCodeRepository.incrementAttempts(record._id);

    if (purpose === 'password_reset') {
      user.resetFailedAttempts = (user.resetFailedAttempts ?? 0) + 1;
      if (user.resetFailedAttempts >= RESET_LOCKOUT_THRESHOLD) {
        user.resetLockedUntil = new Date(Date.now() + RESET_LOCKOUT_MS);
        user.resetFailedAttempts = 0;
      }
      await userRepository.save(user);
    }

    throw new BadRequestError('invalid_code');
  }

  return record;
};
