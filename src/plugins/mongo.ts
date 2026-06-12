import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { env } from '@/lib/env.js';

export default fp(async (app) => {
  mongoose.connection.on('error', (err) => app.log.error(err, 'mongo connection error'));
  mongoose.connection.on('disconnected', () => app.log.warn('mongo disconnected'));
  await mongoose.connect(env.mongoUrl);
  app.log.info({ mongoUrl: env.mongoUrl.replace(/\/\/.*@/, '//***@') }, 'mongo connected');
  app.addHook('onClose', async () => {
    await mongoose.disconnect();
  });
});
