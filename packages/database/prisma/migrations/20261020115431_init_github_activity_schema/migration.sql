-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "RepositoryStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PullRequestState" AS ENUM ('OPEN', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING');

-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('PUSH', 'PULL_REQUEST_OPENED', 'PULL_REQUEST_CLOSED', 'PULL_REQUEST_MERGED', 'PULL_REQUEST_REOPENED', 'PULL_REQUEST_REVIEW', 'ISSUE_OPENED', 'ISSUE_CLOSED', 'RELEASE_PUBLISHED', 'OTHER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "avatar_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "github_user_id" BIGINT NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT,
    "email" TEXT,
    "avatar_url" TEXT,
    "profile_url" TEXT,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "github_id" BIGINT NOT NULL,
    "description" TEXT,
    "url" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "is_fork" BOOLEAN NOT NULL DEFAULT false,
    "status" "RepositoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "pushed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commits" (
    "id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_email" TEXT NOT NULL,
    "author_date" TIMESTAMP(3) NOT NULL,
    "committer_name" TEXT,
    "committer_email" TEXT,
    "committer_date" TIMESTAMP(3),
    "author_user_id" TEXT,
    "url" TEXT,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "total_changes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "github_id" BIGINT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" "PullRequestState" NOT NULL DEFAULT 'OPEN',
    "author_username" TEXT NOT NULL,
    "author_user_id" TEXT,
    "source_branch" TEXT NOT NULL,
    "target_branch" TEXT NOT NULL,
    "is_draft" BOOLEAN NOT NULL DEFAULT false,
    "is_merged" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changed_files" INTEGER NOT NULL DEFAULT 0,
    "merged_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "github_created_at" TIMESTAMP(3) NOT NULL,
    "github_updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "github_id" BIGINT NOT NULL,
    "author_username" TEXT NOT NULL,
    "author_user_id" TEXT,
    "state" "ReviewState" NOT NULL,
    "body" TEXT,
    "commit_sha" TEXT,
    "url" TEXT,
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" TEXT NOT NULL,
    "repository_id" TEXT,
    "user_id" TEXT,
    "github_delivery" TEXT,
    "event_type" "ActivityEventType" NOT NULL,
    "action" TEXT,
    "actor_username" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE INDEX "workspace_members_workspace_id_idx" ON "workspace_members"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_accounts_github_user_id_key" ON "github_accounts"("github_user_id");

-- CreateIndex
CREATE INDEX "github_accounts_user_id_idx" ON "github_accounts"("user_id");

-- CreateIndex
CREATE INDEX "github_accounts_username_idx" ON "github_accounts"("username");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_github_id_key" ON "repositories"("github_id");

-- CreateIndex
CREATE INDEX "repositories_workspace_id_idx" ON "repositories"("workspace_id");

-- CreateIndex
CREATE INDEX "repositories_full_name_idx" ON "repositories"("full_name");

-- CreateIndex
CREATE INDEX "repositories_status_idx" ON "repositories"("status");

-- CreateIndex
CREATE INDEX "commits_repository_id_idx" ON "commits"("repository_id");

-- CreateIndex
CREATE INDEX "commits_author_user_id_idx" ON "commits"("author_user_id");

-- CreateIndex
CREATE INDEX "commits_author_email_idx" ON "commits"("author_email");

-- CreateIndex
CREATE INDEX "commits_author_date_idx" ON "commits"("author_date");

-- CreateIndex
CREATE INDEX "commits_sha_idx" ON "commits"("sha");

-- CreateIndex
CREATE UNIQUE INDEX "commits_repository_id_sha_key" ON "commits"("repository_id", "sha");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_github_id_key" ON "pull_requests"("github_id");

-- CreateIndex
CREATE INDEX "pull_requests_repository_id_idx" ON "pull_requests"("repository_id");

-- CreateIndex
CREATE INDEX "pull_requests_author_user_id_idx" ON "pull_requests"("author_user_id");

-- CreateIndex
CREATE INDEX "pull_requests_state_idx" ON "pull_requests"("state");

-- CreateIndex
CREATE INDEX "pull_requests_author_username_idx" ON "pull_requests"("author_username");

-- CreateIndex
CREATE INDEX "pull_requests_created_at_idx" ON "pull_requests"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_repository_id_number_key" ON "pull_requests"("repository_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_github_id_key" ON "reviews"("github_id");

-- CreateIndex
CREATE INDEX "reviews_pull_request_id_idx" ON "reviews"("pull_request_id");

-- CreateIndex
CREATE INDEX "reviews_author_user_id_idx" ON "reviews"("author_user_id");

-- CreateIndex
CREATE INDEX "reviews_state_idx" ON "reviews"("state");

-- CreateIndex
CREATE INDEX "reviews_author_username_idx" ON "reviews"("author_username");

-- CreateIndex
CREATE INDEX "reviews_submitted_at_idx" ON "reviews"("submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "activity_events_github_delivery_key" ON "activity_events"("github_delivery");

-- CreateIndex
CREATE INDEX "activity_events_repository_id_idx" ON "activity_events"("repository_id");

-- CreateIndex
CREATE INDEX "activity_events_user_id_idx" ON "activity_events"("user_id");

-- CreateIndex
CREATE INDEX "activity_events_event_type_idx" ON "activity_events"("event_type");

-- CreateIndex
CREATE INDEX "activity_events_actor_username_idx" ON "activity_events"("actor_username");

-- CreateIndex
CREATE INDEX "activity_events_occurred_at_idx" ON "activity_events"("occurred_at");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_accounts" ADD CONSTRAINT "github_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commits" ADD CONSTRAINT "commits_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
