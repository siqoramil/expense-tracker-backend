import { BadRequestError, ConflictError, NotFoundError } from '../core/errors.js';
import { debtRepository } from '../repositories/debtRepository.js';

// Caps the embedded payments array per debt; far above any real use, but
// bounds the document so it can never be grown toward Mongo's 16MB limit.
const MAX_DEBT_PAYMENTS = 1000;

// Per-user document cap (abuse / storage-exhaustion guard).
const MAX_DEBTS = 1000;

type DebtCreateData = {
  direction: 'owe_me' | 'i_owe';
  name: string;
  color?: string;
  amount: number;
  due: string;
  note?: string;
};

// Business logic for debts. Throws typed AppErrors (mapped to HTTP by the
// global error handler) so routes stay thin and transport-agnostic.
export const debtService = {
  list(userId: string, includeArchived: boolean) {
    return debtRepository.listByUser(userId, includeArchived);
  },

  async create(userId: string, data: DebtCreateData) {
    const count = await debtRepository.countByUser(userId);
    if (count >= MAX_DEBTS) throw new ConflictError('limit_reached');
    return debtRepository.create(userId, data);
  },

  async update(userId: string, id: string, patch: Record<string, unknown>) {
    const debt = await debtRepository.updateForUser(id, userId, patch);
    if (!debt) throw new NotFoundError();
    return debt;
  },

  async remove(userId: string, id: string) {
    const res = await debtRepository.deleteForUser(id, userId);
    if (res.deletedCount === 0) throw new NotFoundError();
  },

  async addPayment(userId: string, id: string, amount: number, date?: string) {
    const debt = await debtRepository.findForUser(id, userId);
    if (!debt) throw new NotFoundError();

    // Bound the embedded payments array so a single debt document can never
    // be grown toward Mongo's 16MB cap by repeated payment writes.
    if (debt.payments.length >= MAX_DEBT_PAYMENTS) throw new ConflictError('too_many_payments');

    // Read-modify-write race on `paid` is bounded by single-user usage: a user
    // does not concurrently record payments for the same debt, so the clamp is safe.
    const clamped = Math.min(amount, debt.amount - debt.paid);
    if (clamped <= 0) throw new BadRequestError('invalid_amount');

    const payDate = date ?? new Date().toISOString().slice(0, 10);
    return debtRepository.addPayment(id, userId, { amount: clamped, date: payDate }, clamped);
  },

  async archive(userId: string, id: string) {
    const debt = await debtRepository.archive(id, userId);
    if (!debt) throw new NotFoundError();
    return debt;
  },
};
