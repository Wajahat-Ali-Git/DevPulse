# Asynchronous Repository Synchronization Specification

DevPulse provides asynchronous, non-blocking synchronization of GitHub repositories using BullMQ background queues and persistent tracking via PostgreSQL (Prisma).

## Architecture & Responsibilities

- **API Layer (`@devpulse/api`)**:
  - Validates incoming requests and user permissions.
  - Enforces workspace-level tenant isolation and verifies linked GitHub accounts.
  - Checks for active duplicate jobs to prevent resource waste and race conditions.
  - Generates correlation tracking IDs and persists initial `SyncRun` tracking records.
  - Enqueues jobs to the dedicated `repository-sync` BullMQ queue without blocking.
  - Returns immediate `202 Accepted` (or `200 OK`) status with tracking metadata.
  - Serves synchronization status and filtered history from PostgreSQL.

- **Worker Layer (`@devpulse/worker`)**:
  - Listens on the `repository-sync` BullMQ queue with concurrency control (default: 5) and rate-limiting (30 jobs/min).
  - Handles the GitHub API operations via `@devpulse/github`.
  - Paginates repository lists (up to 100 per page) and reports incremental progress.
  - Updates PostgreSQL `SyncRun` state transitions (`PROCESSING`, progress updates, `COMPLETED`, `FAILED`).
  - Classifies errors into transient/retryable (e.g. rate limits, 5xx) vs. permanent (e.g. 401, 404, 422).
  - Redacts sensitive credentials, tokens, and authorization headers from logs and error messages.
  - Supports graceful shutdown (`safeShutdown`) allowing active jobs to finish without job abortion.

---

## Endpoints

### 1. Initiate Repository Synchronization

Enqueues an asynchronous repository synchronization job.

- **Method**: `POST`
- **Path**: `/api/v1/sync/repositories`
- **Auth**: Bearer JWT (requires valid user session)

#### Request Body

```json
{
  "workspaceId": "ws-1234-uuid",
  "githubAccountId": "gh-acc-5678-uuid",
  "scope": "repositories",
  "forced": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | string | **Yes** | Target workspace UUID where repositories belong. Must belong to authenticated user. |
| `githubAccountId` | string | No | Specific linked GitHub account. Defaults to user's primary linked account. |
| `scope` | string | No | Synchronization scope: `'all'`, `'repositories'`, `'metadata'`. Defaults to `'all'`. |
| `forced` | boolean | No | If `true`, bypasses active duplicate job detection and forces full synchronization. |

#### Responses

- **200 / 202 Accepted** (Job enqueued successfully):
```json
{
  "syncId": "sync_user-123_1794821366538_ddn0n",
  "jobId": "sync_user-123_1794821366538_ddn0n",
  "queueName": "repository-sync",
  "jobName": "sync-user-repositories",
  "status": "enqueued",
  "initiatedAt": "2026-11-16T14:26:06.538Z",
  "githubAccountId": "gh-acc-5678-uuid",
  "workspaceId": "ws-1234-uuid",
  "userId": "user-123",
  "scope": "repositories",
  "tracking": {
    "checkStatusUrl": "/api/v1/sync/sync_user-123_1794821366538_ddn0n",
    "correlationId": "sync_user-123_1794821366538_ddn0n",
    "pollingIntervalMs": 2000,
    "estimatedTimeoutMs": 120000
  }
}
```

- **409 Conflict** (Active duplicate job exists):
```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "A synchronization job is already active for this GitHub account and scope (repositories). Wait for it to complete or provide forced=true to override.",
    "details": {
      "activeSyncId": "sync_user-123_1794821366538_ddn0n",
      "githubAccountId": "gh-acc-5678-uuid",
      "scope": "repositories"
    }
  }
}
```

- **403 Forbidden** (User does not have access to specified workspace or account):
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have access to this workspace"
  }
}
```

---

### 2. Get Synchronization Status

Retrieves real-time status, progress, and results of a synchronization job.

- **Method**: `GET`
- **Path**: `/api/v1/sync/:syncId`
- **Auth**: Bearer JWT

#### Response

```json
{
  "syncId": "sync_user-123_1794821366538_ddn0n",
  "jobId": "sync_user-123_1794821366538_ddn0n",
  "queueName": "repository-sync",
  "jobName": "sync-user-repositories",
  "status": "completed",
  "progress": 100,
  "result": {
    "pagesProcessed": 2,
    "totalCount": 135
  },
  "error": null,
  "attemptsMade": 1,
  "userId": "user-123",
  "workspaceId": "ws-1234-uuid",
  "createdAt": "2026-11-16T14:26:06.538Z",
  "processedAt": "2026-11-16T14:26:07.100Z",
  "finishedAt": "2026-11-16T14:26:10.250Z"
}
```

---

### 3. Get Synchronization History

Retrieves historical synchronization runs for workspaces the authenticated user belongs to.

- **Method**: `GET`
- **Path**: `/api/v1/sync/history?workspaceId=...&status=...&limit=20`
- **Auth**: Bearer JWT

#### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | string | No | Filter history by workspace ID. Must be authorized. |
| `status` | string | No | Filter by status (`COMPLETED`, `FAILED`, etc.). |
| `limit` | number | No | Maximum entries to return (default 20, max 100). |

#### Response

```json
[
  {
    "syncId": "sync_user-123_1794821366538_ddn0n",
    "jobId": "sync_user-123_1794821366538_ddn0n",
    "jobName": "sync-user-repositories",
    "queueName": "repository-sync",
    "status": "completed",
    "workspaceId": "ws-1234-uuid",
    "userId": "user-123",
    "enqueuedAt": "2026-11-16T14:26:06.538Z",
    "processedAt": "2026-11-16T14:26:07.100Z",
    "finishedAt": "2026-11-16T14:26:10.250Z",
    "result": { "totalCount": 135 },
    "error": null
  }
]
```

---

## Reliability & Resiliency Features

1. **Retry Policy & Exponential Backoff**:
   - 5 maximum attempts.
   - Exponential backoff starting at 2000ms (2s, 4s, 8s, 16s, 32s).
   - Rate limiters throttle jobs to 30/minute to protect GitHub API limits.

2. **Error Classification**:
   - **Transient errors** (HTTP 502/503/504, network timeouts, ECONNRESET) and **Rate Limits** (HTTP 403/429 with reset timestamps) trigger automatic backoff retries.
   - **Permanent errors** (HTTP 401 Bad Credentials, HTTP 404, HTTP 422 Validation) are wrapped in BullMQ `UnrecoverableError` to avoid burning API quota on unrecoverable requests.

3. **Credential Redaction**:
   - Sensitive tokens (`ghp_*`, `gho_*`, `Bearer ...`, passwords, JWTs) are scrubbed before writing to logs, PostgreSQL `SyncRun.errorMessage`, or failure telemetry.

4. **Idempotency**:
   - Database operations use GitHub repository IDs (`githubId`) for conflict resolution. Unchanged repositories do not generate duplicate database writes.

5. **Graceful Shutdown**:
   - During SIGTERM or module teardown, workers pause intake and wait for active jobs to complete cleanly before disconnecting from Redis.

