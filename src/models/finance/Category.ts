import { Schema, model, type InferSchemaType } from 'mongoose';

const categorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    label: {
      en: { type: String, required: true },
      uz: { type: String, required: true },
    },
    icon: { type: String, required: true },
    color: { type: String, required: true },
    kind: { type: String, enum: ['income', 'expense'], required: true },
  },
  { timestamps: true },
);

categorySchema.index({ userId: 1, createdAt: 1 });

export type CategoryDoc = InferSchemaType<typeof categorySchema>;
export const Category = model('Category', categorySchema);
