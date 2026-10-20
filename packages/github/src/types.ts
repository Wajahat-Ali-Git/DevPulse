/**
 * GitHub API types and structures for DevPulse
 */

export interface GitHubRateLimitInfo {
  limit: number;
  remaining: number;
  reset: number; // Unix epoch seconds
  used: number;
  resource?: string;
}

export interface GitHubPaginationParams {
  page?: number;
  per_page?: number;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
  html_url: string;
  type: string;
  site_admin: boolean;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
  bio?: string | null;
  public_repos?: number;
  public_gists?: number;
  followers?: number;
  following?: number;
  created_at?: string;
  updated_at?: string;
}

export interface GitHubRepositoryOwner {
  id: number;
  login: string;
  avatar_url: string;
  html_url: string;
  type: string;
}

export interface GitHubRepository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  owner: GitHubRepositoryOwner;
  html_url: string;
  description: string | null;
  fork: boolean;
  url: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  git_url: string;
  ssh_url: string;
  clone_url: string;
  default_branch: string;
  open_issues_count: number;
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
  language: string | null;
  archived: boolean;
  disabled: boolean;
  visibility?: 'public' | 'private' | 'internal';
}

export interface GitHubCommitAuthorInfo {
  name: string;
  email: string;
  date: string;
}

export interface GitHubCommitDetail {
  author: GitHubCommitAuthorInfo;
  committer: GitHubCommitAuthorInfo;
  message: string;
  comment_count: number;
  tree: {
    sha: string;
    url: string;
  };
  verification?: {
    verified: boolean;
    reason: string;
  };
}

export interface GitHubCommitStats {
  total: number;
  additions: number;
  deletions: number;
}

export interface GitHubCommitFile {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GitHubCommit {
  sha: string;
  node_id: string;
  commit: GitHubCommitDetail;
  url: string;
  html_url: string;
  comments_url: string;
  author: GitHubUser | null;
  committer: GitHubUser | null;
  parents: Array<{ sha: string; url: string; html_url?: string }>;
  stats?: GitHubCommitStats;
  files?: GitHubCommitFile[];
}

export type GitHubPullRequestState = 'open' | 'closed' | 'all';

export interface GitHubPullRequestBranch {
  label: string;
  ref: string;
  sha: string;
  user: GitHubUser;
  repo: GitHubRepository | null;
}

export interface GitHubPullRequest {
  id: number;
  node_id: string;
  number: number;
  state: 'open' | 'closed';
  locked: boolean;
  title: string;
  user: GitHubUser;
  body: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  draft: boolean;
  html_url: string;
  diff_url: string;
  patch_url: string;
  head: GitHubPullRequestBranch;
  base: GitHubPullRequestBranch;
  merged?: boolean;
  mergeable?: boolean | null;
  comments?: number;
  review_comments?: number;
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export type GitHubReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING';

export interface GitHubReview {
  id: number;
  node_id: string;
  user: GitHubUser;
  body: string | null;
  state: GitHubReviewState;
  html_url: string;
  pull_request_url: string;
  commit_id: string;
  submitted_at: string;
  author_association?: string;
}

export interface GitHubIssue {
  id: number;
  node_id: string;
  url: string;
  repository_url: string;
  html_url: string;
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  user: GitHubUser;
  labels: Array<{
    id: number;
    name: string;
    color: string;
    description?: string | null;
  }>;
  assignee: GitHubUser | null;
  assignees: GitHubUser[];
  locked: boolean;
  comments: number;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  pull_request?: {
    url: string;
    html_url: string;
    diff_url: string;
    patch_url: string;
  };
}

export interface GitHubOAuthTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  error_uri?: string;
}

export interface GitHubWebhookPayload {
  action?: string;
  sender: GitHubUser;
  repository?: GitHubRepository;
  organization?: {
    id: number;
    login: string;
    avatar_url: string;
    url: string;
  };
  installation?: {
    id: number;
    node_id: string;
  };
  [key: string]: any;
}

export interface GitHubPushEventPayload extends GitHubWebhookPayload {
  ref: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  base_ref: string | null;
  compare: string;
  commits: Array<{
    id: string;
    tree_id: string;
    distinct: boolean;
    message: string;
    timestamp: string;
    url: string;
    author: {
      name: string;
      email: string;
      username?: string;
    };
    committer: {
      name: string;
      email: string;
      username?: string;
    };
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  head_commit: {
    id: string;
    tree_id: string;
    distinct: boolean;
    message: string;
    timestamp: string;
    url: string;
    author: {
      name: string;
      email: string;
      username?: string;
    };
    committer: {
      name: string;
      email: string;
      username?: string;
    };
    added: string[];
    removed: string[];
    modified: string[];
  } | null;
}

export interface GitHubPullRequestEventPayload extends GitHubWebhookPayload {
  action:
    | 'opened'
    | 'closed'
    | 'reopened'
    | 'assigned'
    | 'unassigned'
    | 'labeled'
    | 'unlabeled'
    | 'edited'
    | 'synchronize'
    | 'ready_for_review'
    | 'review_requested';
  number: number;
  pull_request: GitHubPullRequest;
}

export interface GitHubPullRequestReviewEventPayload extends GitHubWebhookPayload {
  action: 'submitted' | 'edited' | 'dismissed';
  pull_request: GitHubPullRequest;
  review: GitHubReview;
}

export interface GitHubIssuesEventPayload extends GitHubWebhookPayload {
  action:
    | 'opened'
    | 'edited'
    | 'deleted'
    | 'transferred'
    | 'pinned'
    | 'unpinned'
    | 'closed'
    | 'reopened'
    | 'assigned'
    | 'unassigned'
    | 'labeled'
    | 'unlabeled'
    | 'locked'
    | 'unlocked';
  issue: GitHubIssue;
}
