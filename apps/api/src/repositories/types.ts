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
