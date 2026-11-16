# DevPulse Background Worker (`@devpulse/worker`)

Dedicated background worker microservice for DevPulse responsible for asynchronous job processing, GitHub API synchronization, metrics computation, and scheduling.

## Features

- **BullMQ Queue Processing**: Dedicated queues for `repository-sync`, `github-webhooks`, and `metrics-calculation`.
- **Repository Synchronization (`RepositorySyncWorker`)**:
  - Consumes jobs from the `repository-sync` queue.
  - Interacts with GitHub via `@devpulse/github`.
  - Paginates repository lists and reports incremental progress.
  - Updates PostgreSQL `SyncRun` lifecycle state (`PROCESSING`, `COMPLETED`, `FAILED`).
- **Resilience & Rate-Limiting**:
  - Exponential backoff policy for external API synchronization (up to 5 attempts).
  - Rate limiting (30 jobs / 60 seconds) to prevent secondary GitHub rate-limit blocks.
  - Precise error classification distinguishing transient vs. permanent failures.
- **Graceful Shutdown**:
  - Hooks into NestJS `OnModuleDestroy` lifecycle.
  - Pauses job consumption and permits in-flight jobs to drain cleanly within a configurable timeout.
- **Security & Data Redaction**:
  - Automatic scrubbing of OAuth tokens, PATs, database strings, and secrets from job errors and logs.

## Scripts

```bash
# Run worker in local development mode
pnpm run dev

# Run unit tests
pnpm run test

# Build production bundle
pnpm run build

# Start production worker
pnpm run start:prod
```
