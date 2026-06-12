// Typed application errors. Services throw these instead of touching the HTTP
// `reply`; the global error handler (src/app.ts) maps an AppError to its
// status code and the `{ error: <code> }` envelope. This keeps business logic
// transport-agnostic and removes the scattered inline `reply.code().send()`
// calls that used to live in every route.
//
// `code` is the short snake_case string the mobile client maps to an i18n key
// (e.g. invalid_credentials, wallet_not_found).
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
    this.name = new.target.name;
    // Restore the prototype chain: when this class is transpiled to a target
    // that downlevels `class extends Error`, the instance's prototype is set to
    // Error.prototype, which breaks `err instanceof AppError` in the global
    // error handler. Re-pointing it keeps instanceof working at runtime.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(code = 'bad_request') {
    super(400, code);
  }
}

export class UnauthorizedError extends AppError {
  constructor(code = 'unauthorized') {
    super(401, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(code = 'forbidden') {
    super(403, code);
  }
}

export class NotFoundError extends AppError {
  constructor(code = 'not_found') {
    super(404, code);
  }
}

export class ConflictError extends AppError {
  constructor(code: string) {
    super(409, code);
  }
}

export class LockedError extends AppError {
  constructor(code = 'account_locked') {
    super(423, code);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(code = 'too_many_attempts') {
    super(429, code);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(code: string) {
    super(503, code);
  }
}
