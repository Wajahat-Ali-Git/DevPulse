# DevPulse API Service (`@devpulse/api`)

The primary NestJS REST API application for the DevPulse platform.

## Features

- **Global Error Handling**: Standardized, predictable error JSON responses (`GlobalExceptionFilter`).
- **Validation**: Global `ValidationPipe` with field-level constraint error extraction.
- **Request Tracing**: `x-request-id` and `x-correlation-id` correlation tracking with AsyncLocalStorage.
- **Structured Logging**: Integrated `@devpulse/logger` with automatic PII and secret redaction.
- **Database Safety**: Prisma errors securely mapped to HTTP status codes without leaking internal SQL or schemas.

## Scripts

```bash
# Run local dev server with hot reload
pnpm run dev

# Run unit and filter test suite
pnpm run test

# Build production bundle
pnpm run build
```

## Error Handling

See [`docs/api/error-handling.md`](../../docs/api/error-handling.md) for full error specifications and response examples.
