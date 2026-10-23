# Local Development Setup Guide

Welcome to **DevPulse**! This guide walks you step-by-step from cloning the repository to running all services and verifying system health checks.

---

## Quickstart Workflow

```text
clone repository
      ↓
install dependencies
      ↓
configure environment
      ↓
start Docker services
      ↓
initialize database
      ↓
run API
      ↓
run worker
      ↓
run web
      ↓
verify health checks
```

---

## 1. Prerequisites

Ensure the following tools are installed on your machine:

| Requirement | Minimum Version | Verification Command |
|---|---|---|
| **Node.js** | `>= 20.x` | `node -v` |
| **pnpm** | `>= 9.x` | `pnpm -v` |
| **Docker & Docker Compose** | Engine `>= 24.x` / Compose `>= 2.20` | `docker compose version` |
| **Git** | `>= 2.30` | `git --version` |

> [!TIP]
> If you don't have `pnpm` installed globally, install it using:
> ```bash
> npm install -g pnpm
> ```

---

## 2. Clone the Repository

Clone the DevPulse repository and navigate into the root directory:

```bash
git clone https://github.com/Wajahat-Ali-Git/DevPulse.git
cd DevPulse
```

---

## 3. Install Dependencies

Install all dependencies across the entire monorepo workspace:

```bash
pnpm install
```

This links all internal packages (`@devpulse/database`, `@devpulse/config`, `@devpulse/github`, `@devpulse/logger`, `@devpulse/redis`, `@devpulse/types`) into `node_modules`.

---

## 4. Configure Environment Variables

1. Copy the example environment file to `.env`:
   ```bash
   # On macOS/Linux:
   cp .env.example .env

   # On Windows (PowerShell):
   Copy-Item .env.example .env
   ```

2. The default values in `.env.example` are pre-configured for local Docker development:

| Variable | Default Value | Description |
|---|---|---|
| `NODE_ENV` | `development` | Application runtime mode (`development`, `production`, `test`) |
| `PORT` | `3000` | HTTP port for the REST API server |
| `WORKER_PORT` | `3002` | Port assigned to the background worker |
| `LOG_LEVEL` | `info` | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |
| `POSTGRES_USER` | `postgres` | PostgreSQL username |
| `POSTGRES_PASSWORD` | `postgres` | PostgreSQL password |
| `POSTGRES_DB` | `devpulse` | PostgreSQL database name |
| `POSTGRES_PORT` | `5433` | Host port mapped to Postgres container (avoids conflict with local 5432) |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/devpulse` | Complete Prisma connection string |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_URL` | `redis://localhost:6379` | Complete Redis connection URL |
| `GITHUB_CLIENT_ID` | `dev_github_client_id` | GitHub OAuth client ID (for auth testing) |
| `GITHUB_CLIENT_SECRET` | `dev_github_client_secret` | GitHub OAuth client secret |
| `GITHUB_CALLBACK_URL` | `http://localhost:3000/api/v1/auth/github/callback` | OAuth redirect callback URL |
| `GITHUB_WEBHOOK_SECRET`| `dev_github_webhook_secret` | HMAC secret for verifying GitHub webhooks |
| `JWT_SECRET` | `devpulse_super_secret_jwt_key_32bytes!` | Secret key for JWT signing |
| `JWT_EXPIRES_IN` | `7d` | Token expiry duration |
| `SESSION_SECRET` | `devpulse_super_secret_session_key_32bytes!` | Session encryption key |
| `ENCRYPTION_KEY` | `devpulse_32byte_encryption_key_123!` | Master 32-byte data encryption key |
| `WEB_URL` | `http://localhost:3000` | Web frontend base URL |
| `API_URL` | `http://localhost:3001` | API base URL |
| `WORKER_URL` | `http://localhost:3002` | Background worker base URL |

> [!NOTE]
> All environment variables are validated at application startup by `@devpulse/config` using Zod schemas. If any required variable is missing or malformed, the application will fail fast with a detailed error report.

---

## 5. Start Docker Services

Start the local database (PostgreSQL 16) and message broker (Redis 7) in the background:

```bash
docker compose up -d
```

Verify that both containers are running and healthy:

```bash
docker compose ps
```

Expected output:
```text
NAME                IMAGE                COMMAND                  SERVICE    CREATED         STATUS                   PORTS
devpulse-postgres   postgres:16-alpine   "docker-entrypoint.s…"   postgres   2 minutes ago   Up 2 minutes (healthy)   0.0.0.0:5433->5432/tcp
devpulse-redis      redis:7-alpine       "docker-entrypoint.s…"   redis      2 minutes ago   Up 2 minutes (healthy)   0.0.0.0:6379->6379/tcp
```

---

## 6. Initialize Database (Prisma)

Once PostgreSQL is healthy, run the database setup commands:

1. **Generate the Prisma client**:
   ```bash
   pnpm db:generate
   ```

2. **Apply migrations**:
   ```bash
   pnpm db:migrate:dev
   ```
   This executes the SQL migrations under `packages/database/prisma/migrations`.

3. **Seed initial development data**:
   ```bash
   pnpm db:seed
   ```
   This provisions:
   - Default administrator user (`admin@devpulse.local`)
   - Default organization workspace (`DevPulse Organization`, slug: `devpulse-org`)
   - Tracked repository (`DevPulse/DevPulse`)

---

## 7. Run the Applications

You can start all applications concurrently or run them in separate terminals for focused development and log tracing.

### Option A: Run All Services Concurrently
```bash
pnpm dev
```
Turborepo will start `@devpulse/api`, `@devpulse/worker`, and `@devpulse/web` in parallel.

---

### Option B: Run Services Individually (Recommended for Dev)

Open three terminal windows:

#### Terminal 1 — Start the REST API:
```bash
pnpm --filter @devpulse/api dev
```
- **Output URL**: `http://localhost:3000/api/v1`
- Handles REST requests, authentication, and webhook reception.

#### Terminal 2 — Start the Background Worker:
```bash
pnpm --filter @devpulse/worker dev
```
- Initializes Redis connections and BullMQ queue consumers.
- Handles asynchronous event processing and scheduled synchronization.

#### Terminal 3 — Start the Web Dashboard:
```bash
pnpm --filter @devpulse/web dev
```
- **Output URL**: `http://localhost:3000` (or `http://localhost:3001` if API is on 3000)
- Serves the Next.js 14 engineering analytics dashboard.

---

## 8. Verify Health Checks

DevPulse features built-in multi-level health check probes. Verify your running services with `curl` or your browser:

### 1. Overall Health Probe (`/api/v1/health`)
Checks the status of the API, PostgreSQL, Redis, and configuration loading:

```bash
curl -s http://localhost:3000/api/v1/health | jq .
```

Expected response (`HTTP 200`):
```json
{
  "status": "healthy",
  "timestamp": "2026-10-23T09:30:00.000Z",
  "uptimeSeconds": 15,
  "environment": "development",
  "components": [
    {
      "name": "postgresql",
      "status": "healthy",
      "latencyMs": 4
    },
    {
      "name": "redis",
      "status": "healthy",
      "latencyMs": 2
    },
    {
      "name": "configuration",
      "status": "healthy"
    }
  ]
}
```

### 2. Liveness Probe (`/api/v1/health/live`)
Confirms that the Node.js process is active and capable of serving HTTP traffic:

```bash
curl -s http://localhost:3000/api/v1/health/live | jq .
```

Expected response (`HTTP 200`):
```json
{
  "status": "healthy",
  "timestamp": "2026-10-23T09:30:00.000Z",
  "uptimeSeconds": 15,
  "environment": "development"
}
```

### 3. Readiness Probe (`/api/v1/health/ready`)
Verifies that all infrastructure dependencies (PostgreSQL and Redis) are reachable and ready to handle incoming user traffic:

```bash
curl -s http://localhost:3000/api/v1/health/ready | jq .
```

If all dependencies are reachable, it returns `HTTP 200`. If any dependency is unreachable, it returns `HTTP 503 Service Unavailable` with details on the degraded component.

---

## 9. Development Commands Reference

| Command | Action |
|---|---|
| `pnpm dev` | Starts all applications in development mode with hot-reloading |
| `pnpm build` | Builds all packages and applications |
| `pnpm lint` | Runs ESLint across all packages and apps |
| `pnpm format` | Runs Prettier across all TypeScript and Markdown files |
| `pnpm db:generate` | Re-generates Prisma client types |
| `pnpm db:migrate:dev` | Runs database migrations in development |
| `pnpm db:seed` | Seeds database with initial sample data |
| `pnpm db:studio` | Launches visual Prisma Studio on `http://localhost:5555` |
| `pnpm --filter @devpulse/api test` | Runs API test suite (error handling & health modules) |
| `pnpm --filter @devpulse/github test` | Runs GitHub integration package tests |

---

## 10. Troubleshooting

### Port Conflicts
- **Problem**: `Error: listen EADDRINUSE: address already in use :::5433` or `:::6379`.
- **Solution**: Check if another PostgreSQL or Redis instance is running locally:
  ```bash
  # Check ports in use (Windows PowerShell):
  Get-NetTCPConnection -LocalPort 5433,6379 -ErrorAction SilentlyContinue
  # Or Linux/macOS:
  lsof -i :5433 -i :6379
  ```
  Adjust `POSTGRES_PORT` or `REDIS_PORT` in `.env` and `docker-compose.yml`.

### Database Connection Refused
- **Problem**: `Can't reach database server at localhost:5433`.
- **Solution**: Ensure Docker is running and verify PostgreSQL health:
  ```bash
  docker compose ps
  docker compose logs postgres
  ```

### Config Validation Error (`ZodError`)
- **Problem**: Application crashes on bootstrap with `Configuration Validation Failed`.
- **Solution**: Read the terminal output; it lists the exact variable that failed validation. Check that `.env` contains all variables defined in `.env.example`.
