import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import type { TamaDbConfig } from './config.js';
import { getLogger } from './logging/logger.js';

export const API_PREFIX = '/api/v1';

/**
 * Resolve the running package identity (name, version, description) from
 * package.json at runtime, so `/health` and `/api/v1/info` self-report
 * accurately regardless of release (previously hardcoded, which went stale).
 * Walks up from this module to find the nearest package.json, working under
 * both the compiled `dist/` layout and `tsx` running `src/`.
 */
function resolvePackageInfo(): { name: string; version: string; description: string } {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as {
          name?: string;
          version?: string;
          description?: string;
        };
        if (pkg.name === 'tamadb' && typeof pkg.version === 'string') {
          return {
            name: pkg.name,
            version: pkg.version,
            description: typeof pkg.description === 'string' ? pkg.description : '',
          };
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to defaults
  }
  return { name: 'tamadb', version: 'unknown', description: '' };
}

const PACKAGE_INFO = resolvePackageInfo();
const VERSION = PACKAGE_INFO.version;

/** Process start time, captured once at module load — reported by `/api/v1/info`. */
const STARTED_AT = new Date().toISOString();

/**
 * Resolve the build commit from dist/build-info.json (generated at build time
 * by scripts/gen-build-info.mjs), read from beside the compiled module. Lets
 * operators tell apart two servers built from the same version — important
 * pre-1.0 / during PoC where code is redeployed without a version bump
 * (see the /health build-info requirement). Returns 'unknown' when absent
 * (e.g. running from src/ via tsx without a build).
 */
function resolveCommit(): string {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, 'build-info.json');
      if (existsSync(candidate)) {
        const info = JSON.parse(readFileSync(candidate, 'utf-8')) as { commit?: string };
        if (typeof info.commit === 'string' && info.commit) return info.commit;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to 'unknown'
  }
  return 'unknown';
}

const COMMIT = resolveCommit();

/**
 * Build (but do not start) the Fastify application.
 *
 * Keeping construction separate from listening lets tests use Fastify's
 * `inject()` to exercise routes without binding a real port. As components
 * land (REST API Layer, C15), their route plugins register here.
 */
export async function buildServer(config: TamaDbConfig): Promise<FastifyInstance> {
  const app = Fastify({
    // Reuse the shared TamaDB logger so app + domain logs share one stream.
    // Cast to Fastify's base logger type: pino's Logger and FastifyBaseLogger
    // differ only in optional helpers, and the cast keeps buildServer's return
    // type the default FastifyInstance.
    loggerInstance: getLogger() as unknown as FastifyBaseLogger,
    disableRequestLogging: false,
  });

  // Liveness/readiness probe. Returns the resolved instance config so an
  // operator can confirm the active storage mode and log level (Req: mode
  // exposed via API for inspection).
  app.get('/health', async () => {
    return {
      status: 'ok',
      version: VERSION,
      commit: COMMIT,
      storageMode: config.storageMode,
      logLevel: config.logLevel,
    };
  });

  // Service-discovery / metadata endpoint (distinct from /health, which is the
  // liveness probe). Returns stable identity + where to find the docs, for
  // humans and client tooling. Values are resolved at runtime (package.json /
  // build-info) or from configuration (environment + docs URLs), so nothing is
  // hardcoded or stale. See docs/working-notes/service-info-endpoint-0.5.1.md.
  app.get(`${API_PREFIX}/info`, async () => {
    return {
      name: PACKAGE_INFO.name,
      description: PACKAGE_INFO.description,
      version: VERSION,
      commit: COMMIT,
      apiVersion: API_PREFIX.replace(/^\/api\//, ''),
      environment: config.environment,
      status: 'operational',
      documentation: config.docsUrl,
      openapi: config.openapiUrl,
      startedAt: STARTED_AT,
    };
  });

  return app;
}
