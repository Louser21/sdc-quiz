-- AlterTable
ALTER TABLE "Question" DROP COLUMN "timeLimit";

-- AlterTable
ALTER TABLE "Quiz" ADD COLUMN     "timeLimitSeconds" INTEGER NOT NULL DEFAULT 600;
