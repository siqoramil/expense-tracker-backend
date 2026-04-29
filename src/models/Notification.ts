import { Schema, model, type InferSchemaType } from 'mongoose';

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['overdue', 'budget', 'bill', 'income'], required: true },
    title: {
      en: { type: String, required: true },
      uz: { type: String, required: true },
    },
    body: {
      en: { type: String, required: true },
      uz: { type: String, required: true },
    },
    date: { type: String, required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type NotificationDoc = InferSchemaType<typeof notificationSchema>;
export const Notification = model('Notification', notificationSchema);
