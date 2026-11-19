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

// ── Background Job & Queue Types ──────────────────────────────────────

/**
 * Shared BullMQ Queue Names across DevPulse services.
 */
export enum QueueName {
  GITHUB_WEBHOOKS = 'github-webhooks',
  REPOSITORY_SYNC = 'repository-sync',
  METRICS_CALCULATION = 'metrics-calculation',
  NOTIFICATIONS = 'notifications',
  SAMPLE = 'sample-jobs',
}

/**
 * Shared BullMQ Job Names.
 */
export enum JobName {
  // Webhooks
  PROCESS_WEBHOOK_EVENT = 'process-webhook-event',

  // Repository Sync
  SYNC_USER_REPOSITORIES = 'sync-user-repositories',
  SYNC_SINGLE_REPOSITORY = 'sync-single-repository',
  SYNC_REPOSITORY_COMMITS = 'sync-repository-commits',
  SYNC_REPOSITORY_PULL_REQUESTS = 'sync-repository-pull-requests',
  SYNC_REPOSITORY_ACTIVITY = 'sync-repository-activity',
  SYNC_COMMITS = 'sync-commits',
  SYNC_PULL_REQUESTS = 'sync-pull-requests',

  // Metrics Calculation
  CALCULATE_REPOSITORY_METRICS = 'calculate-repository-metrics',
  CALCULATE_WORKSPACE_METRICS = 'calculate-workspace-metrics',

  // Notifications
  SEND_EMAIL_NOTIFICATION = 'send-email-notification',

  // Sample / Diagnostic
  SAMPLE_JOB = 'sample-job',
}

/**
 * Generic BullMQ Job Priority levels.
 */
export enum JobPriority {
  LOW = 10,
  NORMAL = 5,
  HIGH = 2,
  CRITICAL = 1,
}

/**
 * Payload for GitHub webhook processing job.
 */
export interface WebhookEventPayload {
  deliveryId: string;
  event: string;
  action?: string;
  repositoryId?: string;
  githubRepoId?: number;
  sender?: string;
  rawPayload: Record<string, any>;
  receivedAt: string;
}

/**
 * Supported synchronization scopes for repository synchronization jobs.
 */
export type SyncScope = 'all' | 'repositories' | 'commits' | 'pull_requests' | 'metadata';

/**
 * Status of a synchronization run or background job.
 */
export type SyncRunStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'PARTIALLY_COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Type or scope category of a synchronization run.
 */
export type SyncRunType =
  | 'USER_REPOSITORIES'
  | 'SINGLE_REPOSITORY'
  | 'REPOSITORY_COMMITS'
  | 'REPOSITORY_PULL_REQUESTS'
  | 'REPOSITORY_ACTIVITY'
  | 'FULL';

/**
 * Tracking record for a synchronization run.
 */
export interface SyncRun {
  id: string;
  userId: string;
  githubAccountId?: string | null;
  jobId?: string | null;
  type: SyncRunType;
  status: SyncRunStatus;
  startedAt?: Date | null;
  completedAt?: Date | null;
  lastProcessedAt?: Date | null;
  totalItems: number;
  processedItems: number;
  errorMessage?: string | null;
  scope?: string | null;
  workspaceId?: string | null;
  correlationId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Payload for synchronizing repositories belonging to a user/account.
 * Contains user identifier, linked GitHub account, sync identifier, and requested scope.
 */
export interface RepositorySyncJobPayload {
  /** Authenticated user identifier initiating or owning the synchronization */
  userId: string;
  /** Linked GitHub account identifier used for fetching GitHub resources */
  githubAccountId: string;
  /** Unique synchronization identifier for tracking, status retrieval, and correlation */
  syncId: string;
  /** Requested synchronization scope (e.g. 'all', 'repositories', 'commits', 'pull_requests', 'metadata') */
  scope: SyncScope | string;
  /** Associated workspace identifier */
  workspaceId?: string;
  /** Whether to force a full re-sync bypassing incremental caches */
  forced?: boolean;
  /** Correlation tracking identifier */
  correlationId?: string;
}

/**
 * Payload for synchronizing all repositories belonging to a user/workspace.
 */
export interface SyncUserRepositoriesPayload {
  userId: string;
  workspaceId: string;
  installationId?: number;
  forced?: boolean;
  githubAccountId?: string;
  syncId?: string;
  scope?: SyncScope | string;
}

/**
 * Payload for synchronizing a single repository.
 */
export interface SyncSingleRepositoryPayload {
  repositoryId: string;
  workspaceId: string;
  githubRepoId: number;
  fullName: string;
  userId?: string;
  syncCommits?: boolean;
  syncPullRequests?: boolean;
}

/**
 * Payload for synchronizing commits for a repository.
 */
export interface SyncRepositoryCommitsPayload {
  repositoryId: string;
  workspaceId: string;
  fullName: string;
  since?: string;
  until?: string;
  page?: number;
  perPage?: number;
  syncId?: string;
  userId?: string;
  githubAccountId?: string;
  correlationId?: string;
}

/**
 * Payload for synchronizing pull requests for a repository.
 */
export interface SyncRepositoryPullRequestsPayload {
  repositoryId: string;
  workspaceId: string;
  fullName: string;
  state?: 'open' | 'closed' | 'all';
  page?: number;
  perPage?: number;
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
  syncId?: string;
  userId?: string;
  githubAccountId?: string;
  correlationId?: string;
}

/**
 * Payload for synchronizing repository activity (commits, pull requests, or both).
 */
export interface SyncRepositoryActivityPayload {
  repositoryId: string;
  workspaceId: string;
  fullName: string;
  syncCommits?: boolean;
  syncPullRequests?: boolean;
  since?: string;
  until?: string;
  prState?: 'open' | 'closed' | 'all';
  syncId?: string;
  userId?: string;
  githubAccountId?: string;
  correlationId?: string;
}

/**
 * Payload for calculating repository metrics.
 */
export interface CalculateRepositoryMetricsPayload {
  repositoryId: string;
  workspaceId: string;
  from?: string;
  to?: string;
}

/**
 * Payload for calculating workspace aggregate metrics.
 */
export interface CalculateWorkspaceMetricsPayload {
  workspaceId: string;
  from?: string;
  to?: string;
}

/**
 * Payload for sending notifications.
 */
export interface SendEmailNotificationPayload {
  to: string;
  subject: string;
  template: string;
  context: Record<string, any>;
}

/**
 * Sample job payload for diagnostic testing.
 */
export interface SampleJobPayload {
  message: string;
  timestamp?: number;
}

/**
 * Type map linking JobName enum to its typed payload.
 */
export interface JobPayloadMap {
  [JobName.PROCESS_WEBHOOK_EVENT]: WebhookEventPayload;
  [JobName.SYNC_USER_REPOSITORIES]: SyncUserRepositoriesPayload;
  [JobName.SYNC_SINGLE_REPOSITORY]: SyncSingleRepositoryPayload;
  [JobName.SYNC_REPOSITORY_COMMITS]: SyncRepositoryCommitsPayload;
  [JobName.SYNC_REPOSITORY_PULL_REQUESTS]: SyncRepositoryPullRequestsPayload;
  [JobName.SYNC_REPOSITORY_ACTIVITY]: SyncRepositoryActivityPayload;
  [JobName.SYNC_COMMITS]: SyncRepositoryCommitsPayload;
  [JobName.SYNC_PULL_REQUESTS]: SyncRepositoryPullRequestsPayload;
  [JobName.CALCULATE_REPOSITORY_METRICS]: CalculateRepositoryMetricsPayload;
  [JobName.CALCULATE_WORKSPACE_METRICS]: CalculateWorkspaceMetricsPayload;
  [JobName.SEND_EMAIL_NOTIFICATION]: SendEmailNotificationPayload;
  [JobName.SAMPLE_JOB]: SampleJobPayload;
}


