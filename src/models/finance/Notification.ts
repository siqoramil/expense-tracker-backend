import { Schema, model, type InferSchemaType } from 'mongoose';

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
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

notificationSchema.index({ userId: 1, read: 1 });
notificationSchema.index({ userId: 1, date: -1 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema>;
export const Notification = model('Notification', notificationSchema);
