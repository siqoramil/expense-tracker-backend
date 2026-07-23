import type { FastifyPluginAsync } from 'fastify';
import accountRoutes from './account.js';
import emailRoutes from './email.js';
import passwordRoutes from './password.js';
import profileRoutes from './profile.js';
import sessionRoutes from './session.js';

// All sub-plugins mount at the parent's /auth prefix; the paths inside each
// module are already fully qualified relative to it.
const authRoutes: FastifyPluginAsync = async (app) => {
  await app.register(sessionRoutes);
  await app.register(profileRoutes);
  await app.register(accountRoutes);
  await app.register(emailRoutes);
  await app.register(passwordRoutes);
};

export default authRoutes;
