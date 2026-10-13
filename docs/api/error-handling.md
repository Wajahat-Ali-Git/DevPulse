# API Error Handling Specification

DevPulse provides consistent, structured, and secure error handling across all API endpoints.

## Standard Error Response Format

All error responses return a standardized JSON structure with HTTP status codes matching the category of error:

```json
{
  "success": false,
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Repository not found"
  },
  "requestId": "req_123"
}
```

### Response Properties

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Always `false` for error responses. |
| `error.code` | `string` | Machine-readable error code (e.g. `RESOURCE_NOT_FOUND`, `VALIDATION_ERROR`, `UNAUTHORIZED`). |
| `error.message` | `string` | Human-readable explanation of the error. In production, 5xx internal messages are sanitized to prevent information leakage. |
| `error.details` | `array \| object` | Optional field containing granular validation or context information. |
| `error.stack` | `string` | Stack trace for debugging. **Strictly stripped in production (`NODE_ENV=production`)**. |
| `requestId` | `string` | Request / correlation tracing ID generated or passed via `x-request-id` / `x-correlation-id` headers. |

---

## Validation Errors

When request validation fails (via NestJS `ValidationPipe`, `class-validator`, or Zod schemas), the API returns HTTP 400 with `details` containing field-level issues:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      {
        "field": "email",
        "message": "email must be an email"
      },
      {
        "field": "name",
        "message": "name should not be empty"
      }
    ]
  },
  "requestId": "req_abc123"
}
```

---

## Authentication & Authorization Errors

- **401 Unauthorized**: User or service authentication failed or token missing/expired.
  ```json
  {
    "success": false,
    "error": {
      "code": "UNAUTHORIZED",
      "message": "Authentication required"
    },
    "requestId": "req_abc123"
  }
  ```

- **403 Forbidden**: Authenticated caller lacks permissions to access or mutate the resource.
  ```json
  {
    "success": false,
    "error": {
      "code": "FORBIDDEN",
      "message": "You do not have permission to access this resource"
    },
    "requestId": "req_abc123"
  }
  ```

---

## Database Error Handling (Prisma)

Prisma database errors are safely caught, mapped, and sanitized before returning to the client:

| Prisma Error | HTTP Status | Error Code | Sanitized Production Message |
|---|---|---|---|
| `P2002` (Unique constraint) | `409 Conflict` | `CONFLICT` | `"A resource with this identifier already exists"` |
| `P2025` (Record not found) | `404 Not Found` | `RESOURCE_NOT_FOUND` | `"The requested resource was not found"` |
| `P2003` (Foreign key violation) | `400 Bad Request` | `DATABASE_CONSTRAINT_VIOLATION` | `"Referenced resource does not exist or relation conflict"` |
| `PrismaClientValidationError` | `400 Bad Request` | `VALIDATION_ERROR` | `"Invalid database query parameters"` |
| `PrismaClientInitializationError` | `503 Service Unavailable` | `DATABASE_UNAVAILABLE` | `"Database service is temporarily unavailable"` (DB credentials never leaked) |
| Engine Panics / Unknown | `500 Internal Server Error` | `INTERNAL_SERVER_ERROR` | `"An internal server error occurred"` |

---

## Production Security & Information Hiding

- **Stack Traces**: Never included in production responses (`NODE_ENV === 'production'`).
- **Internal Secrets**: Database connection strings, SQL queries, table schemas, and low-level internal exceptions are stripped from client responses.
- **Server Logging**: Full error objects, stack traces, and request correlation IDs are recorded in server logs via `@devpulse/logger` (with automated redaction of sensitive credentials and tokens).
