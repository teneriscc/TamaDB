# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not in a public issue or discussion.

- **Email:** tamadb@teneris.cc
- **Or** use GitHub's private reporting: the **Report a vulnerability** button on the repository's **Security** tab (available when private vulnerability reporting is enabled).

Please include:

- the TamaDB version (`GET /api/v1/info` returns it),
- the steps to reproduce, and a proof of concept if you have one,
- what an attacker could achieve (impact),
- how you would like to be credited, if at all.

TamaDB is a small project. Reports are acknowledged as soon as possible, but no response time is guaranteed.

## Supported versions

Only the latest release receives fixes. TamaDB is pre-1.0, so any release may change behaviour.

## Read this before reporting: what Increment 1 is

TamaDB Increment 1 is a TypeScript **reference implementation** built to prove the architecture (pipeline model, merge semantics, API contract). A Rust rewrite is planned for production. **It is not hardened for exposure to untrusted networks.**

### Known limitations

These are known and are not new findings. They are deliberate scope limits of Increment 1.

- **No authentication or authorization.** Every endpoint is open to anyone who can reach the port, including `POST /api/v1/admin/shutdown` and the runtime configuration endpoints (log level, log destination, storage strategy, TTL, policies).
- **No TLS.** The server speaks plain HTTP.
- **Listens on all interfaces by default** (`TAMADB_HOST` defaults to `0.0.0.0`). Publishing the container port publishes the unauthenticated API.
- **Webhook callback URLs are not restricted.** A subscription can point TamaDB at any URL it can reach, including internal addresses, and TamaDB will send the delivery there (server-side request forgery by design of an unauthenticated service).
- **The log destination can be set to any file path** through `PUT /api/v1/config/log-destination`; the server then appends its log output to that path.
- **No rate limiting.** Request size is limited only by the HTTP framework's default body limit.
- **Webhook delivery is best-effort.** Pending deliveries are held in memory and are lost on restart. This is documented behaviour, not a vulnerability.

### Recommended way to evaluate TamaDB

- Run it on localhost or an isolated network, for example `docker run -p 127.0.0.1:3000:3000 teneriscc/tamadb`.
- If it must be reachable by other machines, put a reverse proxy in front of it that provides TLS and authentication, and restrict who can reach the port.
- Do not expose it to the internet.

## Reports of most interest

Anything not listed above, for example:

- ways to bypass schema validation or the Document Closed Model,
- data corruption or loss in merge, versioning or TTL handling,
- injection or path-traversal issues in request handling,
- a small request that causes a crash or disproportionate resource use,
- a vulnerability in a dependency that affects the runtime image (`npm audit --omit=dev`).

Thank you for helping to improve TamaDB.
