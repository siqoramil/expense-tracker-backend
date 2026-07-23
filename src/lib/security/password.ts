import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

export const DUMMY_PASSWORD_HASH = bcrypt.hashSync('extracker-timing-safety-placeholder', 12);

export const safeCodeEqual = (a: string, b: string): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
};
