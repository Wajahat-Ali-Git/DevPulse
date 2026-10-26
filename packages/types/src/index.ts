export type UserRole = 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  avatarUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Session {
  id: string;
  userId: string;
  sessionToken: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  expiresAt: Date;
  lastActiveAt: Date;
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  isRevoked: boolean;
  revokedAt?: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  sessionId?: string;
  iat?: number;
  exp?: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}


export interface Repository {
  id: string;
  githubId: number;
  name: string;
  fullName: string;
  owner: string;
  url: string;
  defaultBranch: string;
}

export interface Metric {
  id: string;
  repositoryId: string;
  type: string;
  value: number;
  timestamp: Date;
}

/**
 * Standard error codes used across the DevPulse API.
 */
export enum ApiErrorCode {
  // Client Errors (4xx)
  BAD_REQUEST = 'BAD_REQUEST',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  CONFLICT = 'CONFLICT',
  NOT_ACCEPTABLE = 'NOT_ACCEPTABLE',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  UNPROCESSABLE_ENTITY = 'UNPROCESSABLE_ENTITY',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',

  // Database / Storage Errors
  DATABASE_ERROR = 'DATABASE_ERROR',
  DATABASE_UNAVAILABLE = 'DATABASE_UNAVAILABLE',
  DATABASE_CONSTRAINT_VIOLATION = 'DATABASE_CONSTRAINT_VIOLATION',
  DUPLICATE_RESOURCE = 'DUPLICATE_RESOURCE',

  // Server Errors (5xx)
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  BAD_GATEWAY = 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',
}

/**
 * Individual field or item validation error detail.
 */
export interface ApiErrorDetail {
  field?: string;
  message: string;
  code?: string;
  [key: string]: any;
}

/**
 * Inner error payload of an API error response.
 */
export interface ApiErrorPayload {
  code: string;
  message: string;
  details?: ApiErrorDetail[] | Record<string, any> | any;
  stack?: string;
}

/**
 * Standard API error response shape.
 */
export interface ApiResponseError {
  success: false;
  error: ApiErrorPayload;
  requestId: string;
}

/**
 * Standard API success response shape.
 */
export interface ApiResponseSuccess<T = any> {
  success: true;
  data: T;
  requestId?: string;
}

/**
 * General API response type representing either success or error.
 */
export type ApiResponse<T = any> = ApiResponseSuccess<T> | ApiResponseError;

// ── Health-Check Types ───────────────────────────────────────────────

/**
 * Overall health status of the application or an individual component.
 */
export type HealthStatus = 'healthy' | 'unhealthy' | 'degraded';

/**
 * Health result for a single infrastructure component (e.g. PostgreSQL, Redis).
 */
export interface ComponentHealth {
  status: HealthStatus;
  /** Human-readable component name shown in the response. */
  name: string;
  /** Optional round-trip latency measurement in milliseconds. */
  latencyMs?: number;
  /** Free-form details — typically the error message when unhealthy. */
  details?: string;
}

/**
 * Top-level health-check response returned by the `/health` endpoints.
 */
export interface HealthCheckResponse {
  status: HealthStatus;
  /** ISO-8601 timestamp of when the check was performed. */
  timestamp: string;
  /** Uptime of the process in seconds. */
  uptimeSeconds: number;
  /** Environment the application is running in. */
  environment: string;
  /** Per-component breakdown (omitted on liveness probes). */
  components?: ComponentHealth[];
}

