import { Schema, model, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, default: '' },
    name: { type: String, required: true, trim: true },
    avatar: { type: String, default: '' },
    googleId: { type: String, default: '' },
    // Bumped on credential changes (register, password reset). Any JWT whose
    // `iat` is older than this is rejected, so password reset invalidates
    // every previously-issued token.
    passwordChangedAt: { type: Date, default: () => new Date() },
    // Brute-force lockout state. Each failed /auth/login bumps the counter;
    // hitting the threshold parks `lockedUntil` in the future, after which
    // login refuses regardless of password correctness. A successful login
    // resets both fields. The IP-level rate limit catches floods; this
    // catches slow distributed attacks against a single account.
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    // Per-account brute-force lockout for password reset codes. Survives
    // /password/forgot re-issuance (which resets the per-record attempt
    // counter), so an attacker can't refresh their guess budget by
    // re-requesting a code. Mirrors failedLogins/lockedUntil above; cleared
    // on a successful reset.
    resetFailedAttempts: { type: Number, default: 0 },
    resetLockedUntil: { type: Date, default: null },
    pro: { type: Boolean, default: false },
    prefs: {
      lang: { type: String, enum: ['en', 'uz', 'ru', 'de', 'fr', 'es'], default: 'en' },
      currency: { type: String, enum: ['UZS', 'USD', 'EUR', 'GBP', 'RUB'], default: 'UZS' },
      dark: { type: Boolean, default: false },
      pin: { type: Boolean, default: false },
      notifications: { type: Boolean, default: true },
      biometric: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

// One Google identity may back at most one account. linkGoogle() checks this
// with a read before the write, which leaves a race window where two
// concurrent link requests could both pass; the index closes it at the
// storage layer. Partial, because password-only users all share the ''
// default and a plain unique index would reject every one of them after the
// first.
userSchema.index(
  { googleId: 1 },
  { unique: true, partialFilterExpression: { googleId: { $gt: '' } } },
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
