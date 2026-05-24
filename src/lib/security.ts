import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

// Precomputed at module load (one-time ~100 ms) so /login can call
// bcrypt.compare against this when the email doesn't exist. Without
// it, the response time difference between "no such user" (~5 ms)
// and "wrong password" (~100 ms) reveals account existence to any
// attacker who can measure the response.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  'extracker-timing-safety-placeholder',
  12,
);

// Constant-time compare for fixed-length 6-digit verification codes.
// `===` leaks the matching prefix length through CPU branch timing.
// timingSafeEqual requires equal-length inputs, which is fine here
// because the route schemas already pin codes to /^[0-9]{6}$/.
export const safeCodeEqual = (a: string, b: string): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
};
