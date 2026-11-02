# TamaDB

A **document-centric transmission cache for smart-endpoints/dumb-pipes architectures** — validated, versioned JSON document delivery between data producers and consumers.

TamaDB is a purpose-built intermediary in a smart-endpoints/dumb-pipes architecture. It receives JSON documents, validates them against schemas, stores them temporarily with configurable TTL, and pushes updates to registered consumers via webhooks — in real-time.

## What TamaDB Does

- **Receives** JSON documents from multiple producers via dedicated channels
- **Validates** against registered JSON Schemas (Draft 7) with per-field identity extraction
- **Merges** incoming fields into versioned document state (upsert-only, no data loss)
- **Delivers** updates to consumers via webhooks (Document_Type-level or per-document subscriptions)
- **Expires** documents via a three-scope TTL hierarchy (Document > Document_Type > Instance)

## What TamaDB Is Not

TamaDB is not a general-purpose database. It is intentionally limited: no complex queries, no joins, no aggregations, no business logic. Its strength is speed, simplicity, schema enforcement, and reliable push delivery.

## Quick Start

```bash
# Prerequisites: Node.js 22+
npm ci
npm run build
npm start
```

TamaDB starts on port 3000. Verify:

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"0.1.0","storageMode":"auto","logLevel":"debug"}
```

## Run with Docker

A prebuilt, multi-arch image (`linux/amd64` + `linux/arm64`) is published on Docker Hub — no Node.js install required:

```bash
docker run --rm -p 3000:3000 teneriscc/tamadb:0.1.0
```

To persist state across restarts, mount a volume at the data directory:

```bash
docker run -p 3000:3000 -v tamadb-data:/app/.tamadb-data teneriscc/tamadb:0.1.0
```

Configuration is via environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `TAMADB_PORT` | `3000` | HTTP port the API binds to |
| `TAMADB_HOST` | `0.0.0.0` | Network interface to bind |
| `TAMADB_LOG_LEVEL` | `debug` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `TAMADB_STORAGE_MODE` | `auto` | `auto` \| `memory` \| `disk` \| `hybrid` |

```bash
# Example: quieter logs, in-memory only (no persistence)
docker run --rm -p 3000:3000 -e TAMADB_LOG_LEVEL=info -e TAMADB_STORAGE_MODE=memory teneriscc/tamadb:0.1.0
```

The image runs as a non-root user and exposes a container `HEALTHCHECK` against `/health`.

For a multi-container or reproducible setup, a ready-to-use `compose.yaml` is included in the repository root:

```bash
docker compose up -d
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Document_Type** | The central organising unit. Defines schema, model, TTL, and channels. |
| **Channel** | A per-producer ingestion endpoint with optional enrichment (field injection). |
| **D-Id** | Document Identity — extracted from the document itself via schema annotations. |
| **Upsert** | Single ingestion operation: creates if new, merges if existing. No data is ever removed by a store. |
| **Subscription** | Webhook registration — consumers receive POSTs on document updates. |
| **DCM** | Document Closed Model — strict schema validation, no unknown fields allowed. |

## API Overview

TamaDB exposes ~46 REST endpoints grouped by domain:

| Domain | Endpoints | Description |
|--------|-----------|-------------|
| Schemas | 6 | Register, update, version, decommission, reactivate |
| Document_Types | 5 | Register, list, configure TTL, delete |
| Channels | 9 | Register, activate/deactivate, enrichment bindings |
| Ingestion | 2 | Ingest via Document_Type or channel |
| Documents | 6 | Retrieve, search, glob, delete, per-document TTL |
| Subscriptions | 4 | Subscribe, list, cancel |
| Quarantine | 2 | List and inspect rejected payloads |
| Configuration | 15 | Runtime-changeable: log level, storage strategy, TTL, policies |
| Health & Admin | 2 | Health check, graceful shutdown |

Full API reference: [TamaDB API Catalogue](https://teneris.cc/api-catalogue.html)

## Technology Stack (Increment 1)

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22 (ESM) |
| Language | TypeScript 6 (strict mode) |
| HTTP Framework | Fastify 5 |
| Schema Validation | Ajv 8 (JSON Schema Draft 7) |
| Logging | Pino 10 (structured JSON) |
| Testing | Vitest 4 + fast-check 4 (property-based) |

TypeScript was chosen for rapid concept validation. A Rust rewrite is planned for production deployment. See the [project site](https://teneris.cc) for details.

## Persistence

All configuration state (schemas, Document_Types, channels, subscriptions, enrichment, TTL, quarantine) is persisted via write-through — survives restarts without data loss. Document persistence depends on the storage strategy (`disk`, `hybrid`, `auto`, or `memory`).

To start fresh: delete the `.tamadb-data/` directory.

## Documentation

- [User Manual](docs/user-manual.md) — complete operational guide
- [Presentation Site](https://teneris.cc) — architecture, positioning, roadmap
- [API Catalogue](https://teneris.cc/api-catalogue.html) — full REST endpoint reference

## License

© 2026 Teneris. Licensed under [Apache License 2.0](LICENSE).
