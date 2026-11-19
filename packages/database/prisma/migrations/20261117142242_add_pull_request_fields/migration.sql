-- AlterTable
ALTER TABLE "pull_requests" ADD COLUMN "author_github_id" BIGINT,
ADD COLUMN "raw_payload" JSONB;

-- CreateIndex
CREATE INDEX "pull_requests_author_github_id_idx" ON "pull_requests"("author_github_id");

-- CreateIndex
CREATE INDEX "pull_requests_is_merged_idx" ON "pull_requests"("is_merged");

-- CreateIndex
CREATE INDEX "pull_requests_github_updated_at_idx" ON "pull_requests"("github_updated_at");
