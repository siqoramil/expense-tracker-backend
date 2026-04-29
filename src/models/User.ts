import { Schema, model, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, default: '' },
    name: { type: String, required: true, trim: true },
    avatar: { type: String, default: '' },
    googleId: { type: String, default: '', index: true },
    pro: { type: Boolean, default: false },
    prefs: {
      lang: { type: String, enum: ['en', 'uz', 'ru', 'de', 'fr', 'es'], default: 'en' },
      currency: { type: String, enum: ['UZS', 'USD', 'EUR', 'GBP', 'RUB'], default: 'UZS' },
      dark: { type: Boolean, default: false },
      pin: { type: Boolean, default: false },
      notifications: { type: Boolean, default: true },
      biometric: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
