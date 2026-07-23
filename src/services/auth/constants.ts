export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const CODE_RESEND_COOLDOWN_MS = 60 * 1000;

export const BCRYPT_ROUNDS = 12;

// Account-level brute-force lockout for /login.
export const LOGIN_FAILURE_THRESHOLD = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

// Per-account brute-force lockout for password reset codes. Survives
// /password/forgot re-issuance so an attacker can't refresh their guess
// budget by requesting a new code.
export const RESET_LOCKOUT_THRESHOLD = 5;
export const RESET_LOCKOUT_MS = 15 * 60 * 1000;

export const VERIFIED_TOKEN_TTL = '2m';
export const CODE_TTL_SECONDS = CODE_TTL_MS / 1000;
