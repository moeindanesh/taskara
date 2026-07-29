-- Generic daily-job ledger. Replaces the orphaned SmsDailyReminderRun table, whose service was
-- deleted; the unique (jobKey, dateKey) pair is the cross-restart / multi-instance lock.

-- CreateTable
CREATE TABLE "ScheduledJobRun" (
    "id" UUID NOT NULL,
    "jobKey" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "stats" JSONB,

    CONSTRAINT "ScheduledJobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledJobRun_jobKey_dateKey_key" ON "ScheduledJobRun"("jobKey", "dateKey");

-- CreateIndex
CREATE INDEX "ScheduledJobRun_jobKey_startedAt_idx" ON "ScheduledJobRun"("jobKey", "startedAt");

-- DropTable
DROP TABLE "SmsDailyReminderRun";
