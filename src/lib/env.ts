import 'dotenv/config';

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
};

const parseList = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const env = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  mongoUrl: required('MONGO_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  corsOrigins: parseList(process.env.CORS_ORIGINS),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  // Set to true behind a reverse proxy / TLS terminator that sets
  // X-Forwarded-For. Off by default: trusting the header without a proxy
  // would let any client spoof their source IP.
  trustProxy: process.env.TRUST_PROXY === 'true',
  google: {
    webClientId: process.env.GOOGLE_WEB_CLIENT_ID ?? '',
    iosClientId: process.env.GOOGLE_IOS_CLIENT_ID ?? '',
    androidClientId: process.env.GOOGLE_ANDROID_CLIENT_ID ?? '',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT ?? 465),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? '',
  },
};
