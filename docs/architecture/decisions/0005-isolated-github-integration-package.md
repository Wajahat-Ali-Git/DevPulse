# ADR 0005: Isolated GitHub Integration Package (`@devpulse/github`)

## Status
Accepted

## Date
2026-10-13

## Context
Multiple components in DevPulse need to interact with GitHub:
- `apps/api` handles OAuth callback token exchanges and validates webhook signatures.
- `apps/worker` fetches commits, pull requests, reviews, and issues during scheduled or on-demand synchronizations.

Directly coupling NestJS controllers and worker jobs to raw `fetch` calls or ad-hoc Octokit requests would result in:
- Duplicated authentication and token-refresh logic.
- Inconsistent rate limit detection and retry behavior across services.
- Webhook signature verification code scattered across controllers with potential timing attack vulnerabilities.

## Decision
We established a dedicated, framework-agnostic domain package: **`@devpulse/github`**.

Key capabilities implemented:
1. **Strongly Typed Client (`GitHubClient`)**: High-level submodules (`repositories`, `pullRequests`, `commits`, `reviews`, `issues`, `users`) with full TypeScript return types.
2. **Server-Side Security & Timing-Safe Verification**: Webhook HMAC SHA-256 signatures are validated using Node.js `crypto.timingSafeEqual`, preventing timing attacks.
3. **Resilience & Rate Limit Handling**: Automatic extraction of `x-ratelimit-*` headers, a specialized `GitHubRateLimitError`, exponential backoff for transient server errors, and proactive rate-limit budget tracking.
4. **OAuth Helpers**: Centralized authorization URL generator (`getAuthorizationUrl`) and authorization code exchange (`exchangeCodeForToken`).

## Consequences
- **Positive**:
  - Encapsulates all GitHub API quirks and payload structures in a single place.
  - Ensures uniform rate-limiting compliance across both API and background workers.
  - Unit-tested independently (`pnpm --filter @devpulse/github test`) without spinning up the entire NestJS application.
- **Negative**:
  - Any new GitHub API endpoints must be modeled and typed within `@devpulse/github` before apps can consume them.
