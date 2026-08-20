import {
  buildAppConfig,
  parseServerEnv,
  EnvironmentConfigError,
  findWorkspaceRoot,
  loadRootEnvFiles,
} from '@aytracker/config';
import { disconnectPrisma } from '@aytracker/database';
import { buildApp } from './app.js';
import { buildServices } from './services/container.js';

/**
 * Entry point.
 *
 * Configuration is parsed before anything else: a misconfigured deploy should fail in the first
 * second with a list of what is wrong, not on the first request that happens to need the
 * missing value.
 */
async function main(): Promise<void> {
  // Development convenience only. Anything already in the environment wins, so a platform's
  // injected variables are never overridden by a file left in a working copy.
  loadRootEnvFiles(findWorkspaceRoot(process.cwd()));

  let config;
  try {
    config = buildAppConfig(parseServerEnv());
  } catch (error) {
    if (error instanceof EnvironmentConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const services = buildServices(config);
  const app = await buildApp(config, services);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      // Stop accepting connections, let in-flight requests finish, then release the pool.
      await app.close();
      await disconnectPrisma();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
  });

  try {
    // 0.0.0.0 because Railway routes to the container's external interface.
    await app.listen({ port: config.env.API_PORT, host: '0.0.0.0' });
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

void main();
