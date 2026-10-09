# `@devpulse/config`

Centralized and validated configuration system for all DevPulse applications.

## Features

- **8 Environment Groups**: Application, Database, Redis, GitHub OAuth, GitHub Webhooks, Authentication, Encryption, and URLs.
- **Zod Schema Validation**: Validates all environment variables at startup and throws descriptive, formatted errors if invalid.
- **Production Secret Enforcement**: Prevents application startup when required production secrets are missing or using weak default values.
- **Public vs. Private Separation**: Cleanly separates public non-sensitive settings from sensitive secrets.
- **Monorepo Integration**: Shared across `apps/api`, `apps/worker`, `@devpulse/database`, `@devpulse/redis`, and other packages.

## Environment Groups

| Group | Variables | Description |
|---|---|---|
| **Application** | `NODE_ENV`, `PORT`, `WORKER_PORT`, `LOG_LEVEL` | Application state, port bindings, and log levels |
| **Database** | `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | PostgreSQL connection details |
| **Redis** | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_URL` | Redis connection details |
| **GitHub OAuth** | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL` | GitHub OAuth app credentials |
| **GitHub Webhooks** | `GITHUB_WEBHOOK_SECRET` | Secret token for validating GitHub webhook payloads |
| **Authentication** | `JWT_SECRET`, `JWT_EXPIRES_IN`, `SESSION_SECRET` | Authentication tokens & session keys |
| **Encryption** | `ENCRYPTION_KEY` | Master encryption key for sensitive data |
| **URLs** | `WEB_URL`, `API_URL`, `WORKER_URL` | Microservices base endpoint URLs |

## Usage Examples

### Importing Configuration

```ts
import { config, validateConfig, getPublicConfig, getPrivateConfig } from '@devpulse/config';

// Validate config at application startup
validateConfig();

// Access grouped configuration
console.log(`Running on port ${config.app.port} in ${config.app.nodeEnv} environment`);
console.log(`Database connected at: ${config.database.url}`);

// Access public configuration (safe to send to clients)
const publicConfig = getPublicConfig();

// Access private configuration (server-side secrets)
const privateConfig = getPrivateConfig();
```
