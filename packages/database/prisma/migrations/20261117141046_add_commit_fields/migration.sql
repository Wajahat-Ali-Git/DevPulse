-- AlterTable
ALTER TABLE "commits" ADD COLUMN "author_github_id" BIGINT,
ADD COLUMN "parent_shas" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "raw_payload" JSONB;

-- CreateIndex
CREATE INDEX "commits_author_github_id_idx" ON "commits"("author_github_id");
