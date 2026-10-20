# @devpulse/github

Isolated, strongly-typed GitHub integration layer and client library for DevPulse applications.

## Overview

`@devpulse/github` encapsulates GitHub API communications, authentication flows, rate-limiting handlers, and webhook signature verification so that business logic in `apps/api` and `apps/worker` does not couple to GitHub REST API primitives or duplicate GitHub integration code.

## Package Structure

```
packages/github/
├── src/
│   ├── auth.ts          # OAuth code exchange, token refresh, authorization URLs
│   ├── client.ts        # Core GitHubClient with retries, timeout, and rate-limit tracking
│   ├── commits.ts       # Commit history, commit details, comparisons
│   ├── errors.ts        # Typed error hierarchy (GitHubRateLimitError, 401, 404, etc.)
│   ├── index.ts         # Public API entry point
│   ├── issues.ts        # Issues and issue comments API
│   ├── pull-requests.ts # Pull requests, changed files, PR commits
│   ├── repositories.ts  # Repositories, branches, contributors, languages
│   ├── reviews.ts       # PR review submissions, status, review comments
│   ├── types.ts         # TypeScript interfaces for API entities and webhooks
│   ├── users.ts         # Authenticated user, profile lookups, emails, orgs
│   └── webhooks.ts      # HMAC SHA-256 signature verification & payload parsing
└── package.json
```

## Features

- **Isolated API Logic**: All GitHub REST API paths, payload serializations, and error normalization stay within the package.
- **Typed Models**: Full TypeScript definitions for repositories, commits, pull requests, reviews, issues, and webhook payloads.
- **Error & Rate Limit Handling**: Automatic parsing of `x-ratelimit-*` headers, specific `GitHubRateLimitError` with reset timestamps, exponential backoff retries for server errors, and optional retry-after sleep for rate limits.
- **Server-Side Security**: Credentials (OAuth client secret, access tokens, webhook secret) remain strictly server-side.
- **Webhook Verification**: Timing-safe HMAC SHA-256 validation (`crypto.timingSafeEqual`) preventing timing attacks.

## Usage

### Initializing the Client

```ts
import { GitHubClient } from '@devpulse/github';

const github = new GitHubClient({
  token: process.env.GITHUB_TOKEN, // or user's access token
  oauthConfig: {
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    callbackUrl: process.env.GITHUB_CALLBACK_URL,
  },
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
});
```

### Repositories, Commits, and Pull Requests

```ts
// Fetch repository
const repo = await github.repositories.get('owner', 'repo');

// List pull requests
const prs = await github.pullRequests.list('owner', 'repo', { state: 'open' });

// List commits
const commits = await github.commits.list('owner', 'repo', { since: '2026-01-01T00:00:00Z' });

// Inspect rate limits
const rateLimit = github.getRateLimitInfo();
console.log(`Remaining requests: ${rateLimit?.remaining}`);
```

### Webhook Verification

```ts
import { GitHubWebhooks } from '@devpulse/github';

const isValid = GitHubWebhooks.verifySignature({
  payload: rawBodyBufferOrString,
  signature: req.headers['x-hub-signature-256'],
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
});
```

## Testing

```bash
pnpm --filter @devpulse/github test
```
