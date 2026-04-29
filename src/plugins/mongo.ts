import fp from 'fastify-plugin';
import mongoose from 'mongoose';
import { env } from '../lib/env.js';

export default fp(async (app) => {
  await mongoose.connect(env.mongoUrl);
  app.log.info({ mongoUrl: env.mongoUrl.replace(/\/\/.*@/, '//***@') }, 'mongo connected');
  app.addHook('onClose', async () => {
    await mongoose.disconnect();
  });
});
