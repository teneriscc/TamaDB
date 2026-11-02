# TamaDB Increment 1 — User Manual

## Getting Started

### Prerequisites

- Node.js 22 or later
- npm (comes with Node.js)

### Installation & Startup

```bash
# Clone the repository
git clone https://github.com/teneriscc/TamaDB.git
cd TamaDB

# Install dependencies
npm ci

# Build
npm run build

# Start the server
npm start
# Or for development (auto-reload):
npm run dev
```

TamaDB starts on port 3000 by default. Verify with:

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "ok",
  "version": "0.5.0",
  "commit": "0b8032935370",
  "storageMode": "auto",
  "logLevel": "debug"
}
```

### Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `TAMADB_PORT` | 3000 | HTTP port |
| `TAMADB_HOST` | 0.0.0.0 | Bind address |
| `TAMADB_LOG_LEVEL` | debug | Log level (debug/info/warn/error/silent) |
| `TAMADB_STORAGE_MODE` | auto | Storage strategy (auto/memory/disk/hybrid) |

---

## Step 1: Register a Schema

Before storing documents, define the structure they must follow.

```bash
curl -X POST http://localhost:3000/api/v1/schemas \
  -H "Content-Type: application/json" \
  -d '{
    "ref": "temperature-sensor-v1",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "sensorId": { "type": "string", "identityKind": "primary-key" },
        "location": { "type": "string" },
        "temperature": { "type": "number" },
        "timestamp": { "type": "string" }
      },
      "required": ["sensorId", "location", "temperature"]
    }
  }'
```

Response:
```json
{ "ref": "temperature-sensor-v1", "version": 1 }
```

**Key points:**
- `identityKind: "primary-key"` tells TamaDB which field(s) form the document's identity
- `required` fields must be present in every ingested document (or supplied by enrichment)

### Retrieve a schema

```bash
curl http://localhost:3000/api/v1/schemas/temperature-sensor-v1
```

### Update a schema

```bash
curl -X PUT http://localhost:3000/api/v1/schemas/temperature-sensor-v1 \
  -H "Content-Type: application/json" \
  -d '{
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "sensorId": { "type": "string", "identityKind": "primary-key" },
        "location": { "type": "string" },
        "temperature": { "type": "number" },
        "humidity": { "type": "number" },
        "timestamp": { "type": "string" }
      },
      "required": ["sensorId", "location", "temperature"]
    }
  }'
```

### View schema version history

```bash
curl http://localhost:3000/api/v1/schemas/temperature-sensor-v1/versions
```

### Decommission a schema

Prevents the schema from being used for new Document_Type assignments:

```bash
curl -X POST http://localhost:3000/api/v1/schemas/temperature-sensor-v1/decommission
```

### Reactivate a schema

```bash
curl -X POST http://localhost:3000/api/v1/schemas/temperature-sensor-v1/reactivate
```

---

## Step 2: Register a Document_Type

Group documents under a named type with its Master_Schema.

```bash
curl -X POST http://localhost:3000/api/v1/config/document-types \
  -H "Content-Type: application/json" \
  -d '{
    "name": "temperature-readings",
    "masterSchema": "temperature-sensor-v1",
    "model": "closed",
    "ttl": 3600
  }'
```

Response:
```json
{
  "name": "temperature-readings",
  "masterSchema": "temperature-sensor-v1",
  "model": "closed",
  "ttl": 3600,
  "channels": [],
  "createdAt": "2026-07-17T10:00:00.000Z",
  "updatedAt": "2026-07-17T10:00:00.000Z"
}
```

**Parameters:**
- `model: "closed"` — strict validation, no unknown fields allowed
- `ttl: 3600` — documents expire after 1 hour

### Get a Document_Type configuration

```bash
curl http://localhost:3000/api/v1/config/document-types/temperature-readings
```

### Set per-Document_Type TTL

```bash
curl -X PUT http://localhost:3000/api/v1/config/document-types/temperature-readings/ttl \
  -H "Content-Type: application/json" \
  -d '{ "ttl": 7200 }'
```

### Delete a Document_Type

Requires no documents of that type exist (including soft-deleted):

```bash
curl -X DELETE http://localhost:3000/api/v1/config/document-types/temperature-readings
```

---

## Step 3: Register a Channel (Optional)

Channels give producers their own ingestion endpoint, optionally with enrichment.

```bash
curl -X POST http://localhost:3000/api/v1/config/channels \
  -H "Content-Type: application/json" \
  -d '{
    "channelId": "garage-sensor",
    "documentType": "temperature-readings"
  }'
```

### Add Enrichment Bindings

Enrichment injects fields the producer doesn't need to send:

```bash
curl -X PUT http://localhost:3000/api/v1/config/channels/garage-sensor/enrichment \
  -H "Content-Type: application/json" \
  -d '{
    "bindings": [
      { "fieldPath": "location", "staticValue": "Garage" },
      { "fieldPath": "sensorId", "staticValue": "GARAGE-TEMP-01" }
    ]
  }'
```

Now the producer only needs to send `{"temperature": 22.5}` — TamaDB fills in the rest.

### Get enrichment bindings

```bash
curl http://localhost:3000/api/v1/config/channels/garage-sensor/enrichment
```

### Remove enrichment bindings

```bash
curl -X DELETE http://localhost:3000/api/v1/config/channels/garage-sensor/enrichment
```

### Update a channel

Change the channel schema assignment:

```bash
curl -X PUT http://localhost:3000/api/v1/config/channels/garage-sensor \
  -H "Content-Type: application/json" \
  -d '{ "channelSchema": "temperature-sensor-v1" }'
```

### Deactivate a channel

Suspends ingestion on the channel (operator-controlled):

```bash
curl -X POST http://localhost:3000/api/v1/config/channels/garage-sensor/deactivate
```

### Delete a channel

```bash
curl -X DELETE http://localhost:3000/api/v1/config/channels/garage-sensor
```

---

## Step 4: Ingest Documents

The request body is your **bare JSON document** — exactly the object your producer emits. TamaDB does not require any wrapper. Per-request instructions (version, TTL, expiry, schema) are optional and travel as `TamaDB-*` HTTP headers, not body fields (see below).

### Direct ingestion (Document_Type-level)

```bash
curl -X POST http://localhost:3000/api/v1/ingest/temperature-readings \
  -H "Content-Type: application/json" \
  -d '{
    "sensorId": "LIVING-ROOM-01",
    "location": "Living Room",
    "temperature": 21.5,
    "timestamp": "2026-07-17T10:05:00Z"
  }'
```

Response (201 Created):
```json
{
  "dId": "LIVING-ROOM-01",
  "versionNo": 1,
  "created": true
}
```

### Channel ingestion (with enrichment)

```bash
curl -X POST http://localhost:3000/api/v1/ingest/temperature-readings/garage-sensor \
  -H "Content-Type: application/json" \
  -d '{
    "temperature": 18.2,
    "timestamp": "2026-07-17T10:06:00Z"
  }'
```

Response (201 Created):
```json
{
  "dId": "GARAGE-TEMP-01",
  "versionNo": 1,
  "created": true
}
```

TamaDB enriched the document with `sensorId` and `location` from the channel bindings before storing.

### Update an existing document (upsert)

Send the same sensorId again — TamaDB merges the new temperature into the existing document:

```bash
curl -X POST http://localhost:3000/api/v1/ingest/temperature-readings/garage-sensor \
  -H "Content-Type: application/json" \
  -d '{
    "temperature": 19.1,
    "timestamp": "2026-07-17T10:10:00Z"
  }'
```

Response (200 OK — updated, not created):
```json
{
  "dId": "GARAGE-TEMP-01",
  "versionNo": 2,
  "created": false
}
```

### Per-request instructions: `TamaDB-*` Control_Headers

All per-request instructions are optional HTTP headers in the reserved `TamaDB-*` namespace. The request body stays a pure document; send no headers and you get a blind write at the applicable default TTL.

| Header | Value | Purpose |
|--------|-------|---------|
| `TamaDB-Version` | positive integer (≥ 1) | Optimistic concurrency — write only if the stored version matches (see Step 8). Omit for a blind write. |
| `TamaDB-TTL` | integer seconds (≥ 0), or `infinite` | Document-level TTL. `0` = process-and-forward without caching. |
| `TamaDB-Expire-At` | ISO-8601 timestamp | Expire-at-Point-in-Time — hard delivery deadline regardless of TTL. |
| `TamaDB-Schema` | schema ref | Explicit Storage_Schema override (takes precedence over the URL-derived schema). |

Example — same ingest, now with a one-hour TTL and an explicit schema:

```bash
curl -X POST http://localhost:3000/api/v1/ingest/temperature-readings/garage-sensor \
  -H "Content-Type: application/json" \
  -H "TamaDB-TTL: 3600" \
  -H "TamaDB-Schema: temperature-sensor-v1" \
  -d '{
    "temperature": 19.1,
    "timestamp": "2026-07-17T10:10:00Z"
  }'
```

If a Control_Header is present but its value is invalid (a non-integer TTL, a `TamaDB-Version` below 1, a malformed timestamp, an unknown string), TamaDB rejects the whole request rather than guessing:

```json
{
  "code": "INVALID_CONTROL_HEADER",
  "message": "Invalid value for header TamaDB-Version: expected a positive integer"
}
```

---

## Step 5: Retrieve Documents

### List all Document_Types

```bash
curl http://localhost:3000/api/v1/config/document-types
```

### List all documents in a Document_Type

```bash
# Use glob wildcard * to match all D-Ids
curl http://localhost:3000/api/v1/documents/temperature-readings/*
```

Response:
```json
{
  "matches": [
    { "sensorId": "LIVING-ROOM-01", "location": "Living Room", "temperature": 21.5, ... },
    { "sensorId": "GARAGE-TEMP-01", "location": "Garage", "temperature": 19.1, ... }
  ],
  "count": 2
}
```

### Full document by D-Id

```bash
curl http://localhost:3000/api/v1/documents/temperature-readings/GARAGE-TEMP-01
```

Response:
```json
{
  "sensorId": "GARAGE-TEMP-01",
  "location": "Garage",
  "temperature": 19.1,
  "timestamp": "2026-07-17T10:10:00Z"
}
```

### Retrieve a specific field

```bash
curl "http://localhost:3000/api/v1/documents/temperature-readings/GARAGE-TEMP-01?path=temperature"
```

Response:
```json
{ "_value": 19.1 }
```

### Search by value

```bash
curl -X POST http://localhost:3000/api/v1/documents/temperature-readings/search \
  -H "Content-Type: application/json" \
  -d '{ "field": "location", "value": "Garage" }'
```

Response:
```json
{
  "matches": [
    { "sensorId": "GARAGE-TEMP-01", "location": "Garage", "temperature": 19.1, "timestamp": "2026-07-17T10:10:00Z" }
  ],
  "count": 1
}
```

### Glob pattern matching

```bash
# All sensors starting with "GARAGE"
curl http://localhost:3000/api/v1/documents/temperature-readings/GARAGE-*
```

---

## Step 6: Subscribe to Updates

Register a webhook to receive updates in real-time:

```bash
curl -X POST http://localhost:3000/api/v1/subscriptions \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "document_type",
    "documentType": "temperature-readings",
    "callbackUrl": "https://my-dashboard.example.com/webhook/temperatures",
    "options": {
      "deliveryMode": "retry",
      "payloadFormat": "envelope"
    }
  }'
```

Response (201):
```json
{
  "id": "sub-abc123-0001",
  "scope": "document_type",
  "documentType": "temperature-readings",
  "callbackUrl": "https://my-dashboard.example.com/webhook/temperatures",
  "options": { "deliveryMode": "retry", "payloadFormat": "envelope", "retrievalMode": "full", ... },
  "active": true,
  "createdAt": "2026-07-17T10:15:00Z"
}
```

Now, every time a temperature reading is stored or updated, TamaDB POSTs to your callback:

```json
{
  "subscriptionId": "sub-abc123-0001",
  "dId": "GARAGE-TEMP-01",
  "documentType": "temperature-readings",
  "document": {
    "sensorId": "GARAGE-TEMP-01",
    "location": "Garage",
    "temperature": 19.1
  },
  "timestamp": "2026-07-17T10:10:00Z"
}
```

### Subscribe to a specific document

```bash
curl -X POST http://localhost:3000/api/v1/subscriptions \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "document_id",
    "documentType": "temperature-readings",
    "dId": "LIVING-ROOM-01",
    "callbackUrl": "https://alerts.example.com/living-room"
  }'
```

### List subscriptions

```bash
# All subscriptions for a Document_Type
curl http://localhost:3000/api/v1/document-types/temperature-readings/subscriptions

# Subscriptions for a specific document
curl http://localhost:3000/api/v1/documents/temperature-readings/GARAGE-TEMP-01/subscriptions
```

### Cancel a subscription

```bash
curl -X DELETE http://localhost:3000/api/v1/subscriptions/sub-abc123-0001
```

---

## Step 7: Delete a Document

Soft-delete permanently excludes the document from retrieval and delivery:

```bash
curl -X DELETE http://localhost:3000/api/v1/documents/temperature-readings/LIVING-ROOM-01
```

Response:
```json
{ "deleted": true }
```

The document's data and history are preserved in storage for audit, but it will never be served again.

---

## Step 8: Optimistic Concurrency

Prevent accidental overwrites by supplying the expected version in the `TamaDB-Version` header:

```bash
curl -X POST http://localhost:3000/api/v1/ingest/temperature-readings \
  -H "Content-Type: application/json" \
  -H "TamaDB-Version: 2" \
  -d '{ "sensorId": "LIVING-ROOM-01", "location": "Living Room", "temperature": 23 }'
```

If the document's current version is not 2, TamaDB rejects with:
```json
{
  "code": "VERSION_CONFLICT",
  "message": "Version conflict: expected 2, current is 3"
}
```

Omit the `TamaDB-Version` header for a "blind write" (last-write-wins).

---

## Configuration at Runtime

All configuration is changeable without restart via the API.

### Valid Values Reference

| Category | Valid Values | Default |
|----------|-------------|---------|
| Log Level | `debug`, `info`, `warn`, `error`, `silent` | `debug` |
| Log Destination | `stdout`, `file`, `none` | `stdout` |
| Storage Strategy | `auto`, `memory`, `disk`, `hybrid` | `auto` |
| TTL (Instance-level) | Integer (seconds), `0` = transient, or `"infinite"` | `3600` |
| Quarantine Policy | `off`, `data-errors-only`, `all-rejections` | `data-errors-only` |
| Enrichment Precedence | `environment-over-content`, `content-over-environment` | `environment-over-content` |
| Enrichment Conflict Resolution | `accept-and-warn`, `discard-and-error` | `accept-and-warn` |

### Log Level

```bash
# Check current
curl http://localhost:3000/api/v1/config/log-level

# Change to warn
curl -X PUT http://localhost:3000/api/v1/config/log-level \
  -H "Content-Type: application/json" \
  -d '{ "level": "warn" }'
```

### Log Destination

```bash
# Check current
curl http://localhost:3000/api/v1/config/log-destination

# Switch to file
curl -X PUT http://localhost:3000/api/v1/config/log-destination \
  -H "Content-Type: application/json" \
  -d '{ "destination": "file", "filePath": "./tamadb.log" }'

# Switch back to stdout
curl -X PUT http://localhost:3000/api/v1/config/log-destination \
  -H "Content-Type: application/json" \
  -d '{ "destination": "stdout" }'

# Disable logging
curl -X PUT http://localhost:3000/api/v1/config/log-destination \
  -H "Content-Type: application/json" \
  -d '{ "destination": "none" }'
```

### TTL (Instance-level)

```bash
# Check current
curl http://localhost:3000/api/v1/config/ttl/instance

# Change to 2 hours (7200 seconds)
curl -X PUT http://localhost:3000/api/v1/config/ttl/instance \
  -H "Content-Type: application/json" \
  -d '{ "ttl": 7200 }'
```

### TTL (Per-document)

```bash
# Set TTL for a specific document (overrides Document_Type and instance TTL)
curl -X PUT http://localhost:3000/api/v1/documents/temperature-readings/GARAGE-TEMP-01/ttl \
  -H "Content-Type: application/json" \
  -d '{ "ttl": 1800 }'
```

### TTL Sweep Interval

Controls how frequently TamaDB checks for expired documents (in milliseconds):

```bash
# Change sweep interval to 30 seconds
curl -X PUT http://localhost:3000/api/v1/config/ttl/sweep-interval \
  -H "Content-Type: application/json" \
  -d '{ "interval": 30000 }'
```

### Storage Strategy

```bash
# Check current
curl http://localhost:3000/api/v1/config/storage-strategy

# Change to memory
curl -X PUT http://localhost:3000/api/v1/config/storage-strategy \
  -H "Content-Type: application/json" \
  -d '{ "mode": "memory" }'
```

### Drain Memory to Disk

Flushes all in-memory documents to disk storage. Useful before stopping TamaDB or when switching away from auto/hybrid/memory mode. No-op in `disk` mode.

Note: TamaDB also automatically drains memory to disk on graceful shutdown (Ctrl+C / SIGTERM).

```bash
curl -X POST http://localhost:3000/api/v1/config/storage/drain
```

Response:
```json
{ "drained": true, "documentsWritten": 42, "mode": "auto" }
```

### Quarantine Policy

```bash
# Check current
curl http://localhost:3000/api/v1/config/quarantine-policy

# Change to all-rejections
curl -X PUT http://localhost:3000/api/v1/config/quarantine-policy \
  -H "Content-Type: application/json" \
  -d '{ "policy": "all-rejections" }'
```

### Enrichment Policies

```bash
# Check current
curl http://localhost:3000/api/v1/config/enrichment-policies

# Change policies
curl -X PUT http://localhost:3000/api/v1/config/enrichment-policies \
  -H "Content-Type: application/json" \
  -d '{
    "precedence": "environment-over-content",
    "conflictResolution": "accept-and-warn"
  }'
```

---

## Persistence & Durability

TamaDB persists all state to the `.tamadb-data/` directory so it can resume exactly where it left off after a restart.

### What Survives a Restart

| State | Persisted? | How |
|-------|-----------|-----|
| Schemas (+ version history) | Yes | Write-through on every mutation |
| Document_Types | Yes | Write-through on every mutation |
| Channels (+ status) | Yes | Write-through on every mutation |
| Subscriptions | Yes | Write-through on every mutation |
| Enrichment bindings & policies | Yes | Write-through on every mutation |
| TTL settings (instance, Document_Type, per-document) | Yes | Write-through on every mutation |
| Quarantine entries | Yes | Write-through on every mutation |
| Runtime config (log level, destination, storage strategy) | Yes | Write-through on every mutation |
| Documents | **Depends on storage strategy** | See below |

### Document Durability by Storage Strategy

| Strategy | Document persistence | Trade-off |
|----------|---------------------|-----------|
| `disk` | Every document written to disk immediately on ingest | Safest. Slower writes. |
| `hybrid` | Written to both memory and disk | Fast reads + durable |
| `auto` (default) | Per-operation: uses disk when memory is constrained, memory otherwise | Balanced. Some documents may be in memory only. |
| `memory` | No disk writes. All state lost on restart. | Fastest. Ephemeral only (testing/CI). |

**Graceful shutdown** (Ctrl+C / SIGTERM): TamaDB drains all in-memory documents to disk before exiting. This ensures `auto` and `memory` mode documents are saved — provided the shutdown is graceful.

**Crash / forced kill**: In-memory-only documents (those stored in RAM under `auto` or `memory` mode) may be lost. Configuration state is never lost because it uses write-through persistence.

### Persistence Files

All files live in `.tamadb-data/` (relative to where TamaDB is started):

```
.tamadb-data/
├── schemas.json          — registered schemas and version history
├── document-types.json   — Document_Type configurations
├── channels.json         — channel registrations and status
├── subscriptions.json    — active webhook subscriptions
├── quarantine.json       — quarantined entries
├── enrichment.json       — per-channel bindings and policies
├── ttl.json              — TTL settings (instance, docType, document)
├── config.json           — runtime config (log level, storage strategy)
└── *.json (base64url)    — individual document files (disk store)
```

### Starting Fresh

To reset TamaDB to a clean state (remove all documents, schemas, configuration):

```bash
# Stop TamaDB first, then:
rm -rf .tamadb-data/

# On Windows:
rmdir /s /q .tamadb-data
```

Restart TamaDB — it will start with an empty state and recreate the directory.

### Ephemeral Mode (No Persistence)

Set `TAMADB_STORAGE_MODE=memory` to disable all persistence. In this mode:
- No `.tamadb-data/` directory is created
- All state is in-memory only
- A restart means a complete clean slate
- Useful for automated testing and CI pipelines

```bash
TAMADB_STORAGE_MODE=memory npm start
```

### Graceful Shutdown

TamaDB provides multiple ways to shut down gracefully, ensuring all in-memory documents are drained to disk and state is persisted.

**Method 1: Shutdown API endpoint (recommended — works on all platforms)**

```bash
curl -X POST http://localhost:3000/api/v1/admin/shutdown
```

Response:
```json
{ "status": "shutting-down" }
```

This drains all in-memory documents to disk, persists all configuration state, closes the HTTP server, and exits the process. Works identically on Linux, macOS, and Windows.

**Method 2: Ctrl+C / SIGTERM (Linux/macOS)**

```bash
# If running in foreground:
Ctrl+C

# If running in background:
kill <pid>          # sends SIGTERM
kill -SIGINT <pid>  # sends SIGINT
```

Both signals trigger the same drain + persist + close sequence.

**Method 3: Manual drain before hard stop (Windows fallback)**

If you must use `taskkill /F` or `Stop-Process -Force` (which skip shutdown handlers):

```bash
# First: flush documents to disk
curl -X POST http://localhost:3000/api/v1/config/storage/drain

# Then: stop the process (config state is already persisted via write-through)
taskkill /F /PID <pid>
```

**Summary:**

| Method | Platform | Documents saved? | Config saved? |
|--------|----------|-----------------|---------------|
| `POST /admin/shutdown` | All | Yes | Yes |
| Ctrl+C / SIGTERM | Linux/macOS | Yes | Yes |
| Drain + hard kill | All | Yes | Yes (write-through) |
| Hard kill without drain | All | **Depends on storage strategy** | Yes (write-through) |

---

## Troubleshooting

### Reading Logs

TamaDB outputs structured JSON logs to stdout (default). Each log entry includes:
- `level`: debug, info, warn, error
- `time`: ISO timestamp
- `msg`: human-readable description
- Contextual fields: dId, documentType, channelId, error details

Example log entries:
```json
{"level":"info","time":"2026-07-17T10:05:00Z","msg":"Document stored","documentType":"temperature-readings","dId":"LIVING-ROOM-01","versionNo":1}
{"level":"warn","time":"2026-07-17T10:06:00Z","msg":"Enrichment conflict resolved","fieldPath":"location","winner":"environment"}
{"level":"error","time":"2026-07-17T10:07:00Z","msg":"Schema validation failed","documentType":"temperature-readings","errors":"Field 'temperature' expected type number"}
```

### Inspecting Quarantined Payloads

When a payload is rejected and the quarantine policy permits it, TamaDB stores the original payload for inspection.

**Check the error response for the quarantine reference:**
```json
{
  "code": "SCHEMA_VALIDATION_FAILED",
  "message": "Field 'temperature' expected type number, got string",
  "quarantineRef": "qr-m1abc-0001"
}
```

**Retrieve the quarantined payload:**
```bash
curl http://localhost:3000/api/v1/quarantine/qr-m1abc-0001
```

Response:
```json
{
  "ref": "qr-m1abc-0001",
  "payload": { "sensorId": "BAD-01", "location": "Lab", "temperature": "not-a-number" },
  "context": {
    "receivedAt": "2026-07-17T10:07:00Z",
    "sourceIdentifier": "default",
    "schemaRef": "temperature-sensor-v1",
    "rejectionReason": "Field 'temperature' expected type number, got string",
    "rejectionType": "validation-failure"
  }
}
```

**List all quarantined entries:**
```bash
# All entries
curl http://localhost:3000/api/v1/quarantine

# Filter by type
curl "http://localhost:3000/api/v1/quarantine?rejectionType=parse-error"

# Paginate
curl "http://localhost:3000/api/v1/quarantine?limit=10&offset=0"
```

### Common Error Codes

| Code | HTTP | Meaning | What to do |
|------|------|---------|------------|
| `PARSE_ERROR` | 400 | Payload is not valid JSON | Fix the producer's serialization |
| `SCHEMA_VALIDATION_FAILED` | 422 | Document doesn't match schema | Check required fields, types, extra fields |
| `DOCUMENT_TYPE_NOT_FOUND` | 404 | No such Document_Type registered | Register it first via `/config/document-types` |
| `CHANNEL_NOT_FOUND` | 404 | Channel doesn't exist | Register it via `/config/channels` |
| `CHANNEL_INACTIVE` | 403 | Channel suspended by operator | Activate it: `POST /config/channels/{id}/activate` |
| `CHANNEL_BLOCKED` | 403 | Channel blocked due to schema conflict | Fix the Channel_Schema to be compatible with Master |
| `VERSION_CONFLICT` | 409 | Optimistic concurrency mismatch | Re-read the document's current version and retry |
| `ENRICHMENT_CONFLICT` | 409 | Payload conflicts with enrichment bindings | Check enrichment policy or adjust bindings |
| `DOCUMENT_NOT_FOUND` | 404 | Document doesn't exist or is soft-deleted | Check the `reason` field for details |

### Channel Status Issues

If a channel stops accepting ingestion:

```bash
# Check channel status
curl http://localhost:3000/api/v1/config/channels?documentType=temperature-readings
```

Look at the `status` field:
- `"active"` — accepting ingestion (normal)
- `"inactive"` — operator-suspended. Reactivate: `POST /config/channels/{id}/activate`
- `"blocked"` — schema conflict. Fix the Channel_Schema, then activation becomes possible

---

## Composed D-Ids (Multi-Field Identity)

When a schema has multiple identity fields (e.g., customer + order), D-Ids are composed:

```json
{
  "properties": {
    "customerId": { "type": "string", "identityKind": "parent-key" },
    "orderId": { "type": "string", "identityKind": "primary-key" }
  }
}
```

In URLs, composed D-Ids use `:` as delimiter:
```bash
curl http://localhost:3000/api/v1/documents/orders/customer-A:order-123
```

In request bodies (store response), they're arrays:
```json
{ "dId": ["customer-A", "order-123"] }
```

### Nested identity fields

`identityKind` can annotate fields at any depth — you do not have to flatten your documents. TamaDB discovers annotations by descending through nested objects (and resolving `$ref`), so a real-world identity that lives several levels deep works directly:

```json
{
  "properties": {
    "Identifier": {
      "type": "object",
      "properties": {
        "CreatorReference": {
          "type": "object",
          "properties": {
            "BusinessUnitCode": { "type": "string", "identityKind": "parent-key" },
            "BusinessUnitType": { "type": "string", "identityKind": "parent-key" }
          }
        },
        "Number": { "type": "string", "identityKind": "primary-key" }
      }
    }
  }
}
```

A document like `{ "Identifier": { "CreatorReference": { "BusinessUnitCode": "22648", "BusinessUnitType": "SUP" }, "Number": "ECIS34549" } }` yields the composed D-Id `22648:SUP:ECIS34549`.

Rules to know:
- **Arrays are not traversed.** An `identityKind` inside an array element is ignored (arrays are atomic in Increment 1). Put identity fields on object properties.
- **The annotated field must hold a scalar** (string/number/boolean). Annotating an object (e.g. `Identifier` itself) is rejected at store time with `IDENTITY_FIELD_NOT_SCALAR`. A missing/null identity value is rejected with `MISSING_IDENTITY_FIELD`.
- **Assembly order** is parent-keys first, then primary-keys, each in the order they are discovered top-to-bottom through the schema.

### D-Id values in URLs are encoded

Each part of a composed D-Id is percent-encoded in the URL, so a part value may safely contain the `:` delimiter, a `/`, or other reserved characters. For example a part value `urn:ns:1` is written `urn%3Ans%3A1`; only the delimiters *between* parts are literal colons. When you construct URLs yourself, encode each part (e.g. `encodeURIComponent`) and join with `:`. TamaDB decodes each part on the way in.

---

## Quick Reference: Key Endpoints

| Operation | Method | URL |
|-----------|--------|-----|
| **Schemas** | | |
| Register schema | POST | `/api/v1/schemas` |
| Get schema | GET | `/api/v1/schemas/{schemaRef}` |
| Update schema | PUT | `/api/v1/schemas/{schemaRef}` |
| Schema version history | GET | `/api/v1/schemas/{schemaRef}/versions` |
| Decommission schema | POST | `/api/v1/schemas/{schemaRef}/decommission` |
| Reactivate schema | POST | `/api/v1/schemas/{schemaRef}/reactivate` |
| **Document_Types** | | |
| Register Document_Type | POST | `/api/v1/config/document-types` |
| List Document_Types | GET | `/api/v1/config/document-types` |
| Get Document_Type | GET | `/api/v1/config/document-types/{documentType}` |
| Set Document_Type TTL | PUT | `/api/v1/config/document-types/{documentType}/ttl` |
| Delete Document_Type | DELETE | `/api/v1/config/document-types/{documentType}` |
| **Channels** | | |
| Register channel | POST | `/api/v1/config/channels` |
| List channels | GET | `/api/v1/config/channels?documentType={documentType}` |
| Update channel | PUT | `/api/v1/config/channels/{channelId}` |
| Delete channel | DELETE | `/api/v1/config/channels/{channelId}` |
| Activate channel | POST | `/api/v1/config/channels/{channelId}/activate` |
| Deactivate channel | POST | `/api/v1/config/channels/{channelId}/deactivate` |
| Set enrichment bindings | PUT | `/api/v1/config/channels/{channelId}/enrichment` |
| Get enrichment bindings | GET | `/api/v1/config/channels/{channelId}/enrichment` |
| Delete enrichment bindings | DELETE | `/api/v1/config/channels/{channelId}/enrichment` |
| **Ingestion** | | |
| Ingest (document_type) | POST | `/api/v1/ingest/{documentType}` |
| Ingest (channel) | POST | `/api/v1/ingest/{documentType}/{channelId}` |
| **Documents** | | |
| List documents (glob) | GET | `/api/v1/documents/{documentType}/*` |
| Retrieve document | GET | `/api/v1/documents/{documentType}/{dId}` |
| Retrieve field | GET | `/api/v1/documents/{documentType}/{dId}?path={fieldPath}` |
| Search by value | POST | `/api/v1/documents/{documentType}/search` |
| Delete document | DELETE | `/api/v1/documents/{documentType}/{dId}` |
| Set per-document TTL | PUT | `/api/v1/documents/{documentType}/{dId}/ttl` |
| **Subscriptions** | | |
| Subscribe | POST | `/api/v1/subscriptions` |
| List subscriptions (by type) | GET | `/api/v1/document-types/{documentType}/subscriptions` |
| List subscriptions (by D-Id) | GET | `/api/v1/documents/{documentType}/{dId}/subscriptions` |
| Cancel subscription | DELETE | `/api/v1/subscriptions/{subscriptionId}` |
| **Quarantine** | | |
| List quarantine entries | GET | `/api/v1/quarantine` |
| Inspect quarantine entry | GET | `/api/v1/quarantine/{ref}` |
| **Configuration** | | |
| Get/Set log level | GET/PUT | `/api/v1/config/log-level` |
| Get/Set log destination | GET/PUT | `/api/v1/config/log-destination` |
| Get/Set storage strategy | GET/PUT | `/api/v1/config/storage-strategy` |
| Drain memory to disk | POST | `/api/v1/config/storage/drain` |
| Get/Set quarantine policy | GET/PUT | `/api/v1/config/quarantine-policy` |
| Get/Set enrichment policies | GET/PUT | `/api/v1/config/enrichment-policies` |
| Get/Set instance TTL | GET/PUT | `/api/v1/config/ttl/instance` |
| Set TTL sweep interval | PUT | `/api/v1/config/ttl/sweep-interval` |
| **Health** | | |
| Health check | GET | `/health` |
| **Admin** | | |
| Graceful shutdown | POST | `/api/v1/admin/shutdown` |

---

*Document version: 1.1 — August 2026*
*Corresponds to: TamaDB Increment 1*
