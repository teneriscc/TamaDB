import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildServer, API_PREFIX } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const pkgVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }).version;

describe('server', () => {
  it('exposes a healthy /health endpoint reflecting active config', async () => {
    const config = loadConfig();
    const app = await buildServer(config);

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.storageMode).toBe(config.storageMode);
    expect(body.logLevel).toBe(config.logLevel);
    // /health reports the running version dynamically from package.json
    // (previously hardcoded '0.1.0' and went stale). Must match the package.
    expect(body.version).toBe(pkgVersion);
    // /health reports the build commit (Req 49.3/3a) so operators can tell apart
    // servers built from the same version. Under tsx (no dist/build-info.json)
    // it resolves to 'unknown'; in a built/containerised run it is the commit.
    expect(typeof body.commit).toBe('string');
    expect(body.commit.length).toBeGreaterThan(0);

    await app.close();
  });

  it('uses the versioned API prefix constant', () => {
    expect(API_PREFIX).toBe('/api/v1');
  });

  it('exposes a service-discovery GET /api/v1/info endpoint', async () => {
    const config = loadConfig();
    const app = await buildServer(config);

    const res = await app.inject({ method: 'GET', url: '/api/v1/info' });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Identity resolved at runtime from package.json (never hardcoded/stale).
    expect(body.name).toBe('tamadb');
    expect(typeof body.description).toBe('string');
    expect(body.version).toBe(pkgVersion);
    expect(typeof body.commit).toBe('string');
    expect(body.commit.length).toBeGreaterThan(0);

    // Discovery metadata.
    expect(body.apiVersion).toBe('v1');
    expect(body.environment).toBe(config.environment);
    expect(body.status).toBe('operational');
    expect(body.documentation).toBe(config.docsUrl);
    expect(body.openapi).toBe(config.openapiUrl);
    expect(typeof body.startedAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);

    await app.close();
  });

  it('never leaks the private GitLab host in /api/v1/info docs links', async () => {
    const config = loadConfig();
    const app = await buildServer(config);

    const body = (await app.inject({ method: 'GET', url: '/api/v1/info' })).json();
    // Publishing rule: never link the private GitLab from a server-exposed field.
    expect(body.documentation).not.toContain('gitlab');
    expect(body.openapi).not.toContain('gitlab');
    expect(body.documentation).not.toContain('tamagitlab');
    expect(body.openapi).not.toContain('tamagitlab');

    await app.close();
  });

  it('honours TAMADB_ENV / docs URL overrides via config', async () => {
    const config = { ...loadConfig(), environment: 'staging', docsUrl: 'https://example.test/ref.html', openapiUrl: 'https://example.test/openapi.yaml' };
    const app = await buildServer(config);

    const body = (await app.inject({ method: 'GET', url: '/api/v1/info' })).json();
    expect(body.environment).toBe('staging');
    expect(body.documentation).toBe('https://example.test/ref.html');
    expect(body.openapi).toBe('https://example.test/openapi.yaml');

    await app.close();
  });
});
