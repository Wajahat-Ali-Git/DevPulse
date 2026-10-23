# ADR 0003: Decoupled NestJS REST API and Standalone Background Worker with BullMQ

## Status
Accepted

## Date
2026-10-05

## Context
DevPulse processes both interactive client traffic (web dashboard queries, user logins, repository browsing) and heavy background event streams (high-frequency GitHub webhook ingestion, periodic commits/PR synchronization, metric aggregations).

Processing long-running synchronization tasks directly within the HTTP request thread would:
- Lead to API response timeouts and degraded UI responsiveness.
- Risk GitHub webhook delivery timeouts (GitHub expects an HTTP response within 10 seconds).
- Create memory spikes and CPU contention on the primary API server.

We needed a clean architecture to isolate synchronous HTTP processing from asynchronous background execution.

## Decision
We separated the backend into two distinct deployable applications:
1. **`@devpulse/api`**: A NestJS HTTP application dedicated solely to handling REST requests, validating inputs, checking permissions, and enqueuing background tasks to Redis.
2. **`@devpulse/worker`**: A lightweight, standalone NestJS application context (non-HTTP) utilizing **BullMQ** and **Redis** for job queue processing and periodic scheduling.

Key mechanics:
- The API responds immediately to incoming webhooks with `202 Accepted` after verifying HMAC signatures, and places the payload onto a BullMQ queue.
- The Worker manages queue consumers (`QueueService`, `SampleProcessor`) and scheduled cron jobs (`SchedulerService`).
- Both services share the same database entities (`@devpulse/database`) and typed GitHub client (`@devpulse/github`).

## Consequences
- **Positive**:
  - Independent horizontal scaling: Workers can be scaled up during heavy batch syncs without resizing API servers.
  - Resilience: Worker restarts or crashes do not affect API uptime or user dashboard access.
  - Fast webhook acknowledgments prevent GitHub webhook delivery retry storms.
- **Negative**:
  - Requires maintaining two deployable units and managing Redis availability.
  - Asynchronous event processing introduces eventual consistency between GitHub events and dashboard updates.
