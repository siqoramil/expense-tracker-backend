// Mongo emits code 11000 on a unique-index violation. Mongoose can also wrap
// the driver error as a ValidationError with a nested cause, so check both.
// Shared by every service that maps a duplicate key to a 409 ConflictError.
export const isDuplicateKeyError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; cause?: { code?: number } };
  return e.code === 11000 || e.cause?.code === 11000;
};
