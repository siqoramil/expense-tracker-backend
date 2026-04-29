import { randomInt } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from './env.js';

export const generateCode = () => String(randomInt(100000, 1_000_000));

export type MailPayload = {
  to: string;
  subject: string;
  body: string;
};

let cachedTransporter: Transporter | null = null;

const getTransporter = (): Transporter | null => {
  if (cachedTransporter) return cachedTransporter;
  if (!env.smtp.user || !env.smtp.pass) return null;
  cachedTransporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: { user: env.smtp.user, pass: env.smtp.pass },
  });
  return cachedTransporter;
};

const logToConsole = (payload: MailPayload) => {
  // eslint-disable-next-line no-console
  console.log('\n--- MAIL (dev fallback) ---');
  // eslint-disable-next-line no-console
  console.log(`To: ${payload.to}`);
  // eslint-disable-next-line no-console
  console.log(`Subject: ${payload.subject}`);
  // eslint-disable-next-line no-console
  console.log(payload.body);
  // eslint-disable-next-line no-console
  console.log('---------------------------\n');
};

export const sendMail = async (payload: MailPayload): Promise<void> => {
  const transporter = getTransporter();
  if (!transporter) {
    logToConsole(payload);
    return;
  }
  try {
    await transporter.sendMail({
      from: env.smtp.from || env.smtp.user,
      to: payload.to,
      subject: payload.subject,
      text: payload.body,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('SMTP send failed:', err);
    logToConsole(payload);
    throw new Error('mail_send_failed');
  }
};

export const sendVerificationCode = async (to: string, code: string, reason: string) => {
  await sendMail({
    to,
    subject: 'Your Expense Tracker verification code',
    body: `Your ${reason} code is: ${code}\n\nThis code expires in 10 minutes. If you did not request this, please ignore this email.`,
  });
};
