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
}

export interface SyncRepositoryOptions {
  workspaceId: string;
  userId?: string;
  autoDeactivateOnNotFound?: boolean;
}

