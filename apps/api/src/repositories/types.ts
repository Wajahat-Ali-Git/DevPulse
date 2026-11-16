export interface SyncRepositoryResult {
  repositoryId: string;
  githubId: bigint;
  name: string;
  fullName: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  isRenamed: boolean;
  previousFullName?: string;
  isArchived: boolean;
  isPrivate: boolean;
  action: 'CREATED' | 'UPDATED' | 'DEACTIVATED' | 'UNCHANGED';
  lastSyncedAt?: Date;
  lastSyncError?: string | null;
}

export interface SyncRepositoryOptions {
  workspaceId: string;
  userId?: string;
  autoDeactivateOnNotFound?: boolean;
}

export interface SyncExecutionRecord {
  repositoryId: string;
  fullName: string;
  startedAt: Date;
  completedAt?: Date;
  success: boolean;
  error?: string | null;
  itemsProcessed?: number;
}

export interface ListRepositoriesFilter {
  workspaceId?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  search?: string;
  page?: number;
  perPage?: number;
}

export interface PaginatedRepositoriesResponse<T> {
  data: T[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

export interface InitiateSyncRequestDto {
  githubAccountId?: string;
  workspaceId: string;
  forced?: boolean;
  scope?: string;
}

export interface InitiateSyncResponseDto {
  syncId: string;
  jobId: string;
  queueName: string;
  jobName: string;
  status: 'enqueued';
  initiatedAt: string;
  githubAccountId: string;
  workspaceId: string;
  userId: string;
  scope?: string;
  tracking: {
    checkStatusUrl: string;
    correlationId: string;
    pollingIntervalMs: number;
    estimatedTimeoutMs: number;
  };
}

export interface SyncJobStatusResponseDto {
  syncId: string;
  jobId: string;
  queueName: string;
  jobName: string;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown';
  progress?: number;
  result?: any;
  error?: string | null;
  attemptsMade: number;
  userId?: string;
  workspaceId?: string;
  createdAt?: string;
  processedAt?: string;
  finishedAt?: string;
}

export interface SyncHistoryFilter {
  workspaceId?: string;
  limit?: number;
  status?: string;
}

export interface SyncHistoryItemDto {
  syncId: string;
  jobId: string;
  jobName: string;
  queueName: string;
  status: string;
  workspaceId: string;
  userId: string;
  enqueuedAt: string;
  processedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string | null;
  result?: any;
  githubAccountId?: string;
  scope?: string;
}



