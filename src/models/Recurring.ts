import { Schema, model, type InferSchemaType } from 'mongoose';

const recurringSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['income', 'expense'], required: true },
    cat: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    wallet: { type: Schema.Types.ObjectId, ref: 'Wallet', required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: '' },
    every: { type: String, enum: ['month', 'week'], default: 'month' },
    nextDate: { type: String, required: true },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type RecurringDoc = InferSchemaType<typeof recurringSchema>;
export const Recurring = model('Recurring', recurringSchema);
