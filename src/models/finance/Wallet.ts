import { Schema, model, type InferSchemaType } from 'mongoose';

const walletSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: {
      en: { type: String, required: true },
      uz: { type: String, required: true },
    },
    icon: { type: String, required: true },
    color: { type: String, required: true },
    balance: { type: Number, default: 0 },
  },
  { timestamps: true },
);

walletSchema.index({ userId: 1, createdAt: 1 });

export type WalletDoc = InferSchemaType<typeof walletSchema>;
export const Wallet = model('Wallet', walletSchema);
