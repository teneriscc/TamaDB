/**
 * Runtime configuration for TamaDB.
 *
 * Increment 1 sources configuration from environment variables with sensible
 * defaults. Per the spec: logging defaults to DEBUG/stdout, storage strategy
 * defaults to AUTO. Values here are the instance-level defaults; several are
 * runtime-changeable via the REST API (e.g. log level, storage mode).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type StorageMode = 'auto' | 'memory' | 'disk' | 'hybrid';

export interface TamaDbConfig {
  /** HTTP port the REST API binds to. */
  port: number;
  /** Network interface to bind. */
  host: string;
  /** Default log level (runtime-changeable via API). */
  logLevel: LogLevel;
  /** Default storage strategy mode (runtime-changeable via API). */
  storageMode: StorageMode;
  /**
   * Deployment environment label reported by `GET /api/v1/info` (e.g.
   * `development`, `staging`, `production`). Increment 1 is a PoC with no
   * production deployment, so the default is honest: `increment-1`. Override
   * with `TAMADB_ENV`.
   */
  environment: string;
  /**
   * URL of the human-facing API reference (Redoc), reported by
   * `GET /api/v1/info`. Configurable because the running server may be anyone's
   * self-hosted instance, not the public site. Default points at the public
   * docs; override with `TAMADB_DOCS_URL`. (Never set this to the private
   * GitLab.)
   */
  docsUrl: string;
  /**
   * URL of the machine-readable OpenAPI document, reported by
   * `GET /api/v1/info` for tooling discovery. Override with `TAMADB_OPENAPI_URL`.
   */
  openapiUrl: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name]?.toLowerCase();
  return (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== '' ? raw : fallback;
}

export function loadConfig(): TamaDbConfig {
  return {
    port: envInt('TAMADB_PORT', 3000),
    host: process.env.TAMADB_HOST ?? '0.0.0.0',
    logLevel: envEnum('TAMADB_LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'], 'debug'),
    storageMode: envEnum('TAMADB_STORAGE_MODE', ['auto', 'memory', 'disk', 'hybrid'], 'auto'),
    environment: envStr('TAMADB_ENV', 'increment-1'),
    docsUrl: envStr('TAMADB_DOCS_URL', 'https://tamadb.cc/api-reference.html'),
    openapiUrl: envStr('TAMADB_OPENAPI_URL', 'https://tamadb.cc/openapi.yaml'),
  };
}
