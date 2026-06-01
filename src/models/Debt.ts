import { Schema, model, type InferSchemaType } from 'mongoose';

const paymentSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    date: { type: String, required: true },
  },
  { _id: true, timestamps: false },
);

const debtSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    direction: { type: String, enum: ['owe_me', 'i_owe'], required: true },
    name: { type: String, required: true, trim: true },
    color: { type: String, default: '#6366F1' },
    amount: { type: Number, required: true, min: 0 },
    paid: { type: Number, default: 0, min: 0 },
    due: { type: String, required: true },
    note: { type: String, default: '' },
    payments: [paymentSchema],
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);

debtSchema.index({ userId: 1, archived: 1 });

export type DebtDoc = InferSchemaType<typeof debtSchema>;
export const Debt = model('Debt', debtSchema);
