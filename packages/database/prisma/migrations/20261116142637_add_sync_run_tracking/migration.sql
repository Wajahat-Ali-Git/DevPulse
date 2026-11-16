-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncRunType" AS ENUM ('USER_REPOSITORIES', 'SINGLE_REPOSITORY', 'REPOSITORY_COMMITS', 'REPOSITORY_PULL_REQUESTS', 'FULL');

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "github_account_id" TEXT,
    "job_id" TEXT,
    "type" "SyncRunType" NOT NULL DEFAULT 'USER_REPOSITORIES',
    "status" "SyncRunStatus" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "last_processed_at" TIMESTAMP(3),
    "total_items" INTEGER NOT NULL DEFAULT 0,
    "processed_items" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "scope" TEXT,
    "workspace_id" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_runs_user_id_idx" ON "sync_runs"("user_id");

-- CreateIndex
CREATE INDEX "sync_runs_status_idx" ON "sync_runs"("status");

-- CreateIndex
CREATE INDEX "sync_runs_job_id_idx" ON "sync_runs"("job_id");

-- CreateIndex
CREATE INDEX "sync_runs_github_account_id_idx" ON "sync_runs"("github_account_id");

-- CreateIndex
CREATE INDEX "sync_runs_workspace_id_idx" ON "sync_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "sync_runs_created_at_idx" ON "sync_runs"("created_at");

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

