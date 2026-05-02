import { Schema, model, type InferSchemaType } from 'mongoose';

const schema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    code: { type: String, required: true },
    purpose: {
      type: String,
      enum: ['email_change', 'password_reset', 'account_delete'],
      required: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    newEmail: { type: String, default: null, lowercase: true, trim: true },
    expiresAt: { type: Date, required: true },
    consumed: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type VerificationCodeDoc = InferSchemaType<typeof schema>;
export const VerificationCode = model('VerificationCode', schema);
