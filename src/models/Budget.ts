import { Schema, model, type InferSchemaType } from 'mongoose';

const budgetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    cat: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    limit: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

budgetSchema.index({ userId: 1, createdAt: 1 });

export type BudgetDoc = InferSchemaType<typeof budgetSchema>;
export const Budget = model('Budget', budgetSchema);
