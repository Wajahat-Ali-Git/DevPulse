-- AlterTable
ALTER TABLE "repositories" ADD COLUMN "last_synced_at" TIMESTAMP(3),
ADD COLUMN "last_commit_sync_at" TIMESTAMP(3),
ADD COLUMN "last_pr_sync_at" TIMESTAMP(3);
