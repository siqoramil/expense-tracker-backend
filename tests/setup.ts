// Set required env BEFORE the app modules import dotenv/env.ts.
// dotenv won't override already-set vars, so test values win.
process.env.MONGO_URL = 'mongodb://test/test';
process.env.JWT_SECRET = 'test-jwt-secret-very-long-for-tests-1234567890';
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGINS = '';
process.env.GOOGLE_WEB_CLIENT_ID = '';
process.env.GOOGLE_IOS_CLIENT_ID = '';
process.env.GOOGLE_ANDROID_CLIENT_ID = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.SWAGGER_USER = 'docs';
process.env.SWAGGER_PASS = 'docs-test-pass';

// Avoid actually opening a Mongo connection during tests. Models can still
// be defined; smoke tests don't reach the DB because they're either
// schema-rejected (400) or auth-rejected (401) before any query runs.
const { default: mongoose } = await import('mongoose');
mongoose.connect = (async () => mongoose) as typeof mongoose.connect;
mongoose.disconnect = (async () => undefined) as typeof mongoose.disconnect;
