import { Schema, model, type InferSchemaType } from 'mongoose';

const transactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['income', 'expense'], required: true },
    cat: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    wallet: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: '' },
    date: { type: String, required: true }, // YYYY-MM-DD
  },
  { timestamps: true },
);

transactionSchema.index({ userId: 1, date: -1, createdAt: -1 });
transactionSchema.index({ userId: 1, kind: 1, date: -1 });
transactionSchema.index({ userId: 1, date: -1, kind: 1, amount: 1 });

export type TransactionDoc = InferSchemaType<typeof transactionSchema>;
export const Transaction = model('Transaction', transactionSchema);
