export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
    this.name = new.target.name;
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
