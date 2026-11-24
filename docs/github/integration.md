# GitHub Integration Guide

This guide details the GitHub integration architecture within **DevPulse**, including OAuth setup, webhook ingestion, HMAC signature verification, background worker processing, and rate-limit handling.

---

## 1. Overview

DevPulse relies on GitHub as its primary source of engineering activity data. The integration architecture consists of:
1. **`@devpulse/github`**: A dedicated, strongly-typed internal package managing GitHub REST API calls, OAuth token exchanges, and timing-safe webhook validation.
2. **`@devpulse/api`**: Ingests incoming GitHub webhooks (`POST /api/v1/webhooks/github`), validates HMAC SHA-256 signatures, and enqueues events onto Redis queues.
3. **`@devpulse/worker`**: Asynchronously dequeues webhook payloads, fetches missing metadata from GitHub, upserts domain records into PostgreSQL, and computes engineering metrics.

---

## 2. Integration Architecture & Data Flow

```mermaid
sequenceDiagram
    autonumber
    participant GH as GitHub (Webhooks & API)
    participant API as @devpulse/api
    participant Redis as Redis (BullMQ Queue)
    participant Worker as @devpulse/worker
    participant DB as PostgreSQL (Prisma)

    rect rgb(240, 248, 255)
    Note over GH,API: 1. Real-time Ingestion (Sync)
    GH->>API: POST /api/v1/webhooks/github<br/>[Header: X-Hub-Signature-256]
    API->>API: Verify HMAC SHA-256 using timingSafeEqual
    alt Invalid Signature
        API-->>GH: 401 Unauthorized
    else Valid Signature
        API->>Redis: Enqueue job to 'github-events' queue
        API-->>GH: 202 Accepted { received: true, delivery: id }
    end
    end

    rect rgb(245, 255, 245)
    Note over Redis,DB: 2. Event Processing (Async)
    Worker->>Redis: Dequeue event job
    alt Additional Details Needed
        Worker->>GH: Query GitHub API (with backoff & rate-limit check)
        GH-->>Worker: Return PR files / commit stats
    end
    Worker->>DB: Upsert repository, PR, commit, or review records
    Worker->>DB: Record immutable event in activity_events
    Worker->>Redis: Acknowledge job completion
    end
```

---

## 3. The `@devpulse/github` Package

All direct communication with the GitHub platform is isolated within `packages/github`.

### Package Submodules

```text
packages/github/src/
├── auth.ts          # OAuth authorization URL generation & code token exchange
├── client.ts        # Core GitHubClient with retries, timeout, and rate-limiting
├── commits.ts       # Commit history, commit details, comparisons
├── errors.ts        # Typed error hierarchy (GitHubRateLimitError, 401, 404, etc.)
├── issues.ts        # Issues and issue comments API
├── pull-requests.ts # Pull requests, changed files, diffs, PR commits
├── repositories.ts  # Repositories, branches, contributors, languages
├── reviews.ts       # PR review submissions, state tracking, review comments
├── types.ts         # TypeScript interfaces for API entities and webhooks
├── users.ts         # Authenticated user, profile lookups, emails, orgs
└── webhooks.ts      # HMAC SHA-256 signature verification & payload parsing
```

### Initializing the Client

```typescript
import { GitHubClient } from '@devpulse/github';

const github = new GitHubClient({
  token: process.env.GITHUB_TOKEN, // Personal access token or OAuth installation token
  oauthConfig: {
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    callbackUrl: process.env.GITHUB_CALLBACK_URL,
  },
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
});
```

---

## 4. GitHub OAuth Setup Guide

DevPulse allows developers to link their GitHub identities to view their teams and repositories.

### 4.1. Creating a GitHub OAuth Application
1. In your GitHub account, navigate to **Settings** > **Developer Settings** > **OAuth Apps**.
2. Click **New OAuth App**.
3. Fill in the application details:
   - **Application name**: `DevPulse Local` (or `DevPulse Staging / Production`)
   - **Homepage URL**: `http://localhost:3000` (Next.js web URL)
   - **Authorization callback URL**: `http://localhost:3000/api/v1/auth/github/callback` (or your configured `GITHUB_CALLBACK_URL`)
4. Click **Register application**.
5. Copy the generated **Client ID**.
6. Generate and copy a new **Client Secret**.

### 4.2. Environment Configuration
Update your `.env` file with the generated credentials:
```env
GITHUB_CLIENT_ID=your_github_client_id_here
GITHUB_CLIENT_SECRET=your_github_client_secret_here
GITHUB_CALLBACK_URL=http://localhost:3000/api/v1/auth/github/callback
```

### 4.3. Required Scopes
DevPulse requests the following permissions during the OAuth authorization flow:
- `read:user`: To read profile information (username, avatar, name).
- `user:email`: To resolve and link commit author emails to DevPulse users.
- `repo`: To read repository metadata, commits, pull requests, and review comments for tracked repositories.

---

## 5. GitHub Webhook Configuration

Webhooks provide real-time updates when commits are pushed, pull requests are opened/merged, or code reviews are submitted.

### 5.1. Webhook Endpoint Setup
1. In your GitHub repository or organization, go to **Settings** > **Webhooks** > **Add webhook**.
2. Configure the webhook settings:
   - **Payload URL**: `https://<your-domain-or-tunnel>/api/v1/webhooks/github`
   - **Content type**: `application/json` (strictly required)
   - **Secret**: Set a secure secret string matching `GITHUB_WEBHOOK_SECRET` in your `.env`.
   - **SSL verification**: Enable SSL verification.
3. Select **Let me select individual events** and check:
   - `Pushes` (`push`)
   - `Pull requests` (`pull_request`)
   - `Pull request reviews` (`pull_request_review`)
   - `Issues` (`issues`)
   - `Releases` (`release`)
4. Save the webhook.

### 5.2. Webhook Ingestion & Validation Endpoint (`POST /api/v1/webhooks/github`)
DevPulse exposes a dedicated, unauthenticated (`@Public()`) endpoint to receive incoming GitHub webhooks:
- **Route**: `POST /api/v1/webhooks/github`
- **Status Code**: `202 Accepted` on successful receipt and signature verification.
- **Headers Validated**:
  - `Content-Type`: Must be `application/json` (otherwise `400 Bad Request`).
  - `X-GitHub-Event`: GitHub event type (e.g., `push`, `pull_request`, `pull_request_review`, `repository`, `ping`) (otherwise `400 Bad Request`).
  - `X-GitHub-Delivery`: Unique delivery GUID assigned by GitHub (otherwise `400 Bad Request`).
  - `X-Hub-Signature-256`: HMAC SHA-256 signature calculated with `GITHUB_WEBHOOK_SECRET` (otherwise `401 Unauthorized`).
- **Supported Events**:
  - `push`: Requires `ref`, `commits` list, and `repository` object.
  - `pull_request`: Requires `action`, `pull_request` (id, number), and `repository`.
  - `pull_request_review`: Requires `action`, `pull_request`, `review` (id, state), and `repository`.
  - `repository`: Requires `action` and `repository`.
  - `ping`: Initial ping hook verification, acknowledged immediately with `202 Accepted`.
  - *Unsupported events*: Safely ignored with `202 Accepted` and `{ status: "ignored" }` to prevent unnecessary failure alerts on GitHub.
- **Normalized Event Metadata Extracted**:
  - `deliveryId`: Unique delivery GUID from `X-GitHub-Delivery`.
  - `eventType`: Event name from `X-GitHub-Event`.
  - `repositoryGitHubId` & `repositoryFullName`: Parsed from `repository.id` and `repository.full_name`.
  - `senderGitHubId`: Parsed from `sender.id` where present.
  - `action`: Event action (e.g., `opened`, `submitted`, `created`).
  - `receivedAt`: High-resolution ingestion timestamp.
- **Connected Account & Ownership Validation**:
  - Senders and repositories are validated against connected accounts (`GitHubAccount.githubUserId`) and registered repositories (`Repository.githubId`) in PostgreSQL. Unverified IDs are never trusted directly.
- **Asynchronous Architecture**:
  - The webhook endpoint performs fast, non-blocking ingestion (<10ms) without triggering expensive synchronous database synchronizations or GitHub API roundtrips.
- **Raw Body Verification**: Verification checks the exact raw request bytes before JSON parsing to guarantee signature accuracy.
- **Security**: Error messages avoid leaking internal stack traces, configuration states, or signature values.

### 5.3. Timing-Safe Signature Verification
To prevent timing side-channel attacks, `@devpulse/github` uses constant-time comparison via Node.js `crypto.timingSafeEqual`:

```typescript
import { GitHubWebhooks } from '@devpulse/github';

const isValid = GitHubWebhooks.verifySignature({
  payload: rawPayloadStringOrBuffer,
  signature: req.headers['x-hub-signature-256'] as string,
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
});

if (!isValid) {
  throw new UnauthorizedException('Invalid GitHub webhook signature');
}
```

### 5.3. Idempotency & Delivery Guarantees
GitHub sends a unique delivery GUID in the `X-GitHub-Delivery` header. DevPulse tracks this in the `activity_events` database table:
- **Column**: `github_delivery` (`VARCHAR(255) UNIQUE`)
- **Behavior**: If GitHub re-transmits a webhook event, the database unique constraint prevents duplicate processing and state corruption.

---

## 6. Rate Limiting & Resilience

GitHub enforces rate limits (e.g., 5,000 requests per hour for authenticated requests). The `@devpulse/github` package includes built-in safeguards:

1. **Header Inspection**: Every response extracts:
   - `x-ratelimit-limit`: Maximum request allowance.
   - `x-ratelimit-remaining`: Requests remaining in the current window.
   - `x-ratelimit-reset`: Unix timestamp when the quota resets.
2. **`GitHubRateLimitError`**: Thrown specifically when HTTP 403 / 429 indicates rate-limit exhaustion, containing the reset timestamp.
3. **Exponential Backoff**: Transient network errors (500, 502, 503, 504) automatically trigger exponential backoff retries with jitter.
4. **Budget Monitoring**: Workers inspect remaining rate limit capacity before launching large batch repository synchronizations.

---

## 7. Activity Synchronization Workflow (Commits & Pull Requests)

DevPulse implements robust background activity synchronization for repositories, tracking commits and pull requests with support for pagination, incremental checkpoints, author resolution, and duplicate prevention.

### 7.1. Synchronization Jobs

Activity synchronization is managed by `@devpulse/worker` through BullMQ jobs:
- **`SYNC_COMMITS` (`sync-repository-commits`)**: Synchronizes commit history for a repository starting from the last known checkpoint or the beginning of time.
- **`SYNC_PULL_REQUESTS` (`sync-repository-pull-requests`)**: Synchronizes pull requests, updating lifecycle states (`OPEN`, `CLOSED`, `MERGED`), draft statuses, and branches.
- **`SYNC_REPOSITORY_ACTIVITY` (`sync-repository-activity`)**: An orchestration job that sequentially triggers both commit and pull request synchronization for a target repository and updates composite progress.

### 7.2. Incremental Synchronization & Checkpoints

To optimize API usage and avoid unnecessary rate-limit consumption:
1. **Checkpoint Storage**:
   - `Repository.lastCommitSyncAt`: Checkpoint for commits.
   - `Repository.lastPrSyncAt`: Checkpoint for pull requests.
   - `Repository.lastSyncedAt`: Overall synchronization timestamp.
2. **Overlapping Safety Window**:
   - Incremental commit requests use `since = lastCommitSyncAt - 5 minutes` (300,000 ms).
   - This prevents dropped records caused by out-of-order commits, clock skew, or network latency during active pushes.
3. **Full Synchronization Fallback**:
   - When no checkpoint exists (initial repository sync), a full synchronization runs without a `since` filter.

### 7.3. Deduplication & Upsertion Semantics

- **Commits**: Uniquely identified by composite key `(repositoryId, sha)`. Re-syncing commits updates author resolution or raw payloads without inserting duplicates.
- **Pull Requests**: Uniquely identified by `githubId` and natural key `(repositoryId, number)`. Reconciled by `updated_at` timestamps so status changes (e.g., opened -> merged) cleanly update existing database rows.
- **Author Attribution**:
  - Worker attempts to map `authorGithubId` via `GitHubAccount.githubUserId`.
  - If unmapped, resolves by matching Git commit author email with `User.email`.
  - Gracefully falls back to unlinked author representation (`authorUserId: null`) for commits authored by users without registered accounts.

---

## 8. Local Testing & Webhook Simulation

### 8.1. Exposing Localhost to GitHub
For local webhook testing without deploying to a public server, use a tunnel:
```bash
# Using ngrok
ngrok http 3000

# Using Smee.io
smee --url https://smee.io/your-unique-channel --target http://localhost:3000/api/v1/webhooks/github
```

### 8.2. Running Package Unit Tests
Run the automated test suite for `@devpulse/github`:
```bash
pnpm --filter @devpulse/github test
```
The test suite verifies:
- Client submodule instantiation
- OAuth authorization URL construction
- Webhook signature verification and invalid signature rejection
- Rate limit parsing and error hierarchy
