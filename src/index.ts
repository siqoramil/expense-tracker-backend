import { buildApp } from './app.js';
import { env } from './lib/env.js';

const main = async () => {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error(reason, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal(err, 'uncaughtException');
    process.exit(1);
  });

  try {
    await app.listen({ port: env.port, host: env.host });
    app.log.info(`listening http://${env.host}:${env.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void main();
