import { Schema, model, type InferSchemaType } from 'mongoose';

const transactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['income', 'expense'], required: true },
    cat: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    wallet: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: '' },
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
  },
  { timestamps: true },
);

transactionSchema.index({ userId: 1, date: -1 });

export type TransactionDoc = InferSchemaType<typeof transactionSchema>;
export const Transaction = model('Transaction', transactionSchema);
