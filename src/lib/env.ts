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

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';

// HS256 with a 256-bit secret is the floor for "not trivially
// brute-forceable offline" by 2026 hardware. 32 chars of any
// reasonable charset clears that bar; we refuse to boot below it
// so a mis-set deploy can never ship with a default-ish secret.
const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error(
    `JWT_SECRET must be at least 32 chars (got ${jwtSecret.length}). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
  );
}

// Refuse to start in production against a plaintext Mongo URL. mongodb+srv
// implies TLS; explicit ?tls=true or ssl=true also counts. Internal-only
// replica sets behind a private network can opt out with
// MONGO_ALLOW_INSECURE=true (documented escape hatch, not the default).
const mongoUrl = required('MONGO_URL');
if (isProd && process.env.MONGO_ALLOW_INSECURE !== 'true') {
  const looksTls = mongoUrl.startsWith('mongodb+srv://') || /[?&](tls|ssl)=true\b/i.test(mongoUrl);
  if (!looksTls) {
    throw new Error(
      'Production MONGO_URL must use mongodb+srv:// or include tls=true. ' +
        'Set MONGO_ALLOW_INSECURE=true only if Mongo is on a private network.',
    );
  }
}

const rawJwtExpiresIn = process.env.JWT_EXPIRES_IN ?? '7d';
const jwtExpiresInMatch = /^(\d+)[smhd]$/.exec(rawJwtExpiresIn);
if (!jwtExpiresInMatch || Number(jwtExpiresInMatch[1]) === 0) {
  throw new Error(
    `JWT_EXPIRES_IN must match \\d+[smhd] with a positive value (e.g. "7d", "1h"). Got: "${rawJwtExpiresIn}".`,
  );
}
if (isProd) {
  const seconds = Number(jwtExpiresInMatch[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[jwtExpiresInMatch[0].slice(-1) as 's' | 'm' | 'h' | 'd'];
  if (seconds < 3600) {
    throw new Error(
      `JWT_EXPIRES_IN must be at least 1h in production (got "${rawJwtExpiresIn}"). ` +
        'Short-lived tokens break revocation assumptions.',
    );
  }
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  mongoUrl,
  jwtSecret,
  jwtExpiresIn: rawJwtExpiresIn,
  corsOrigins: parseList(process.env.CORS_ORIGINS),
  nodeEnv,
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
