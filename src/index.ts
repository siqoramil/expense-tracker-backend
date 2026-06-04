import { buildApp } from './app.js';
import { env } from './lib/env.js';

const main = async () => {
  const app = await buildApp();
  try {
    await app.listen({ port: env.port, host: env.host });
    app.log.info(`listening http://${env.host}:${env.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void main();
