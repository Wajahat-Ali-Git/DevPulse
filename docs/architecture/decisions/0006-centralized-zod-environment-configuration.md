# ADR 0006: Centralized Configuration with Zod Validation (`@devpulse/config`)

## Status
Accepted

## Date
2026-10-13

## Context
A distributed monorepo with multiple apps and shared packages has dozens of configuration variables (ports, database URLs, Redis hosts, secrets, encryption keys, and third-party credentials).

Relying on raw `process.env.VAR_NAME` accesses across various files introduces:
- Silent runtime failures caused by missing or typoed environment variables.
- Weak or unvalidated values in production (e.g. default placeholder JWT secrets).
- Inconsistent parsing of integers (ports), booleans, and connection strings.
- Inability to safely distinguish between public settings (safe for client-side) and private secrets.

## Decision
We implemented a centralized configuration package, **`@devpulse/config`**, powered by **Zod schema validation**.

Key features:
1. **Schema Definition**: A strict Zod schema (`packages/config/src/schema.ts`) covering 8 environment groups:
   - Application (`NODE_ENV`, `PORT`, `WORKER_PORT`, `LOG_LEVEL`)
   - Database (`DATABASE_URL`, `POSTGRES_*`)
   - Redis (`REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_URL`)
   - GitHub OAuth (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`)
   - GitHub Webhooks (`GITHUB_WEBHOOK_SECRET`)
   - Authentication (`JWT_SECRET`, `JWT_EXPIRES_IN`, `SESSION_SECRET`)
   - Encryption (`ENCRYPTION_KEY`)
   - URLs (`WEB_URL`, `API_URL`, `WORKER_URL`)
2. **Early Startup Validation**: `validateConfig()` is called in the bootstrap lifecycle of `apps/api` and `apps/worker`. If validation fails, the process exits immediately with a formatted list of missing/invalid variables.
3. **Production Secret Enforcement**: Rejects placeholder secrets (e.g. `dev_github_client_id` or `devpulse_super_secret_jwt_key_*`) when `NODE_ENV=production`.
4. **Public vs. Private Exposure**: Exports typed accessors (`getPublicConfig()` and `getPrivateConfig()`) to prevent leaking backend credentials.

## Consequences
- **Positive**:
  - Fail-fast system behavior: Misconfigured services cannot start in an unhealthy state.
  - Full TypeScript autocomplete for all nested configuration values (`config.app.port`, `config.database.url`).
  - Production readiness is guaranteed before traffic is served.
- **Negative**:
  - Any newly introduced environment variables must be declared in both `.env.example` and `packages/config/src/schema.ts`.
