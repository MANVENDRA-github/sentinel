import 'dotenv/config';
import { loadServerEnv, loadConfig } from './config.js';
import { createRegistry } from './providers/registry.js';
import { buildServer } from './server.js';
import { ConfigError } from './errors.js';

async function main(): Promise<void> {
  const env = loadServerEnv(process.env);
  const config = loadConfig({ path: env.configPath, env: process.env });
  const registry = createRegistry(config);
  const app = buildServer({ registry, apiKeys: env.apiKeys });
  await app.listen({ port: env.port, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigError ? error.message : `Failed to start Sentinel: ${String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
