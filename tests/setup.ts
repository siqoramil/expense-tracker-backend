process.env.MONGO_URL = 'mongodb://test/test';
process.env.JWT_SECRET = 'test-jwt-secret-very-long-for-tests-1234567890';
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGINS = '';
process.env.GOOGLE_WEB_CLIENT_ID = '';
process.env.GOOGLE_IOS_CLIENT_ID = '';
process.env.GOOGLE_ANDROID_CLIENT_ID = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const { default: mongoose } = await import('mongoose');
mongoose.connect = (async () => mongoose) as typeof mongoose.connect;
mongoose.disconnect = (async () => undefined) as typeof mongoose.disconnect;

export {};